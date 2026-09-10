import { formatUnits } from "viem";
import {
  type Allocation,
  type Nft,
  type Policy,
  type Pool,
  type Snapshot,
  type OptimizationMetrics,
  validatePolicy,
} from "./domain.ts";

function invariant(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

type Candidate = {
  p: Pool;
  r: number;
  b: number;
  f: number;
  competitionVotes: number;
  density: number;
  maxGain: number;
};

function units(n: string | bigint) {
  return Number(formatUnits(BigInt(n), 18));
}

function prepareCandidates(
  snapshot: Snapshot,
  policy: Policy,
  total: number,
): { candidates: Candidate[]; valuedPools: number } {
  // Build one candidate per valued, live pool. `b` is risk-adjusted external
  // voting power (all local NFT votes are removed first), while `f` is local
  // power that the current run cannot move. `competitionVotes` deliberately
  // uses unadjusted external votes plus fixed votes: it is the pool size used
  // by the noise filter, while `density` uses the risk-adjusted denominator
  // used by the optimizer.
  //
  // `maxGain` is an optimistic standalone gain for up to `cap` new votes. It
  // remains useful for fallback ordering and combinatorial search, but is not
  // exposed as a candidate threshold because it is not the final allocation.
  const excludedPools = new Set(
    policy.excludedPools.map((pool) => pool.toLowerCase()),
  );
  const valued = snapshot.pools
    .filter(
      (pool) =>
        pool.rewardUsd > 0 &&
        !excludedPools.has(pool.address.toLowerCase()),
    )
    .map((pool) => {
      const all = snapshot.nfts.reduce(
        (sum, nft) => sum + BigInt(nft.current[pool.address.toLowerCase()] ?? "0"),
        0n,
      );
      const fixed = snapshot.nfts
        .filter((nft) => !nft.eligible)
        .reduce(
          (sum, nft) =>
            sum + BigInt(nft.current[pool.address.toLowerCase()] ?? "0"),
          0n,
        );
      invariant(
        BigInt(pool.votes) >= all,
        "Pool votes smaller than owned votes",
      );
      const external = units(BigInt(pool.votes) - all);
      const reward = pool.rewardUsd * (1 - policy.rewardHaircut);
      const externalRisk = Math.max(1e-18, external * policy.dilution);
      const fixedPower = units(fixed);
      const cap = Math.min(total * policy.maxShare, total);
      const maxGain =
        reward *
        ((fixedPower + cap) /
          (externalRisk + fixedPower + cap) -
          fixedPower / (externalRisk + fixedPower));
      return {
        p: pool,
        r: reward,
        b: externalRisk,
        f: fixedPower,
        competitionVotes: external + fixedPower,
        density: reward / Math.max(externalRisk + fixedPower, 1e-18),
        maxGain,
      };
    });
  if (!valued.length) return { candidates: [], valuedPools: 0 };

  const minimum = Math.ceil(1 / policy.maxShare - 1e-10);
  const passes = (candidate: Candidate) => {
    // This is an AND for removal, not an AND for admission. A low-vote pool
    // with unusually good reward density is often exactly the pool worth
    // voting for, so remove only pools that are both small and unattractive
    // on a per-vote basis.
    const lowVotes =
      policy.candidateMinVotes > 0 &&
      candidate.competitionVotes < policy.candidateMinVotes;
    const lowDensity =
      policy.candidateMinRewardPerVoteUsd > 0 &&
      candidate.density < policy.candidateMinRewardPerVoteUsd;
    return !(lowVotes && lowDensity);
  };
  let candidates = valued.filter(passes);

  // Thresholds are allowed to be strict, but never leave maxShare infeasible.
  // If the user asks for an aggressive filter, the best potential pools are
  // put back until at least `minimum` pools remain.
  if (candidates.length < minimum) {
    const fallback = valued
      .filter((candidate) => !candidates.includes(candidate))
      .sort((a, b) => b.maxGain - a.maxGain || b.r - a.r);
    candidates = [
      ...candidates,
      ...fallback.slice(0, minimum - candidates.length),
    ];
  }

  return { candidates, valuedPools: valued.length };
}

/**
 * Solve the pure aggregate allocation problem. Chain reads and transaction
 * execution deliberately stay outside this module so the mathematical core
 * can be tested independently and replaced by an exact subset solver later.
 */
export function optimizeDetailed(
  snapshot: Snapshot,
  policy: Policy,
): {
  allocations: Allocation[];
  metrics: OptimizationMetrics;
} {
  validatePolicy(policy);
  const eligible = snapshot.nfts.filter((nft) => nft.eligible);
  const power = eligible.reduce((sum, nft) => sum + BigInt(nft.power), 0n);
  const total = units(power);
  const emptyMetrics = (
    valuedPools = 0,
    candidatePools = 0,
  ): OptimizationMetrics => ({
    eligibleNfts: eligible.length,
    totalVotingPower: power.toString(),
    valuedPools,
    candidatePools,
    filteredPools: Math.max(0, valuedPools - candidatePools),
    selectedPools: 0,
    selectedPoolAddresses: [],
    estimatedRewardUsd: 0,
  });
  if (power === 0n) return { allocations: [], metrics: emptyMetrics() };
  invariant(
    Number.isInteger(snapshot.maxPools) && snapshot.maxPools > 0,
    "Snapshot maxVotingNum must be a positive integer",
  );
  const k = snapshot.maxPools;
  const prepared = prepareCandidates(snapshot, policy, total);
  const candidates = prepared.candidates;
  if (!candidates.length)
    return {
      allocations: [],
      metrics: emptyMetrics(prepared.valuedPools),
    };

  const solve = (items: Candidate[]) => {
    // KKT/water-filling solution for the concave aggregate objective.
    invariant(
      items.length * policy.maxShare >= 1 - 1e-10,
      "Too few valued pools for maxShare",
    );
    let lo = 0;
    let hi = Math.max(
      ...items.map((candidate) =>
        (candidate.r * candidate.b) /
        (candidate.b + candidate.f) ** 2,
      ),
    );
    for (let i = 0; i < 180; i++) {
      const mid = (lo + hi) / 2;
      const used = items.reduce(
        (sum, candidate) =>
          sum +
          Math.min(
            total * policy.maxShare,
            Math.max(
              0,
              Math.sqrt((candidate.r * candidate.b) / mid) -
                candidate.b -
                candidate.f,
            ),
          ),
        0,
      );
      if (used > total) lo = mid;
      else hi = mid;
    }
    return items.map((candidate) =>
      Math.min(
        total * policy.maxShare,
        Math.max(
          0,
          Math.sqrt((candidate.r * candidate.b) / hi) -
            candidate.b -
            candidate.f,
        ),
      ),
    );
  };

  const relaxed = solve(candidates);
  const relaxedSelection = candidates
    .map((candidate, index) => ({ candidate, amount: relaxed[index] }))
    .sort(
      (a, b) =>
        b.amount - a.amount ||
        a.candidate.p.address.localeCompare(b.candidate.p.address),
    )
    .slice(0, k)
    .map(({ candidate }) => candidate);
  const value = (items: Candidate[]) => {
    const amounts = solve(items);
    return items.reduce(
      (sum, candidate, index) =>
        sum +
        candidate.r *
          ((candidate.f + amounts[index]) /
            (candidate.b + candidate.f + amounts[index]) -
            candidate.f / (candidate.b + candidate.f)),
      0,
    );
  };

  const minimum = Math.ceil(1 / policy.maxShare - 1e-10);
  invariant(k >= minimum, "Too few valued pools for maxShare");
  let greedy: Candidate[] =
    minimum === 1
      ? []
      : relaxedSelection.slice(0, minimum);
  while (greedy.length < Math.min(k, candidates.length)) {
    let best: Candidate | undefined;
    let bestValue = greedy.length ? value(greedy) : -Infinity;
    for (const candidate of candidates) {
      if (greedy.includes(candidate)) continue;
      const trialValue = value([...greedy, candidate]);
      if (trialValue > bestValue + 1e-10) {
        best = candidate;
        bestValue = trialValue;
      }
    }
    if (!best) break;
    greedy.push(best);
  }

  const SCALE = 1000000000000n;
  const precisionShare = 1 / Number(SCALE);
  let selected =
    greedy.length && value(greedy) >= value(relaxedSelection)
      ? greedy
      : relaxedSelection;
  const minimumShare = Math.max(policy.minSelectedShare, precisionShare);
  while (selected.length > minimum) {
    const amounts = solve(selected);
    const kept = selected.filter(
      (_, index) => amounts[index] / total >= minimumShare,
    );
    if (kept.length === selected.length) break;
    if (kept.length < minimum) {
      const ranked = selected
        .map((candidate, index) => ({ candidate, amount: amounts[index] }))
        .sort((a, b) => b.amount - a.amount);
      selected = ranked.slice(0, minimum).map(({ candidate }) => candidate);
      break;
    }
    selected = kept;
  }

  const amounts = solve(selected);
  const weights = amounts.map((amount) =>
    amount > 0
      ? BigInt(Math.floor((amount / total) * Number(SCALE)))
      : 0n,
  );
  const positive = selected
    .map((candidate, index) => ({ candidate, weight: weights[index] }))
    .filter(({ weight }) => weight > 0n);
  invariant(positive.length > 0, "Allocation rounded to zero");
  const weightSum = positive.reduce((value, item) => value + item.weight, 0n);
  const allocations = eligible.map((nft) => {
    const usable = positive.filter(
      ({ weight }) => (BigInt(nft.power) * weight) / weightSum > 0n,
    );
    invariant(
      usable.length === positive.length,
      "NFT voting power too small for allocation precision",
    );
    return {
      tokenId: nft.tokenId,
      owner: nft.owner,
      power: nft.power,
      pools: usable.map(({ candidate }) => candidate.p.address),
      weights: usable.map(({ weight }) => weight.toString()),
      estimatedRewardUsd: 0,
    };
  });
  allocations.forEach((allocation) => {
    allocation.estimatedRewardUsd = positive.reduce((sum, item) => {
      const own = units(
        (BigInt(allocation.power) * item.weight) / weightSum,
      );
      const added = allocations.reduce(
        (totalAdded, nft) =>
          totalAdded +
          units((BigInt(nft.power) * item.weight) / weightSum),
        0,
      );
      return (
        sum +
        (item.candidate.r * own) /
          (item.candidate.b + item.candidate.f + added)
      );
    }, 0);
  });
  return {
    allocations,
    metrics: {
      eligibleNfts: eligible.length,
      totalVotingPower: power.toString(),
      valuedPools: prepared.valuedPools,
      candidatePools: candidates.length,
      filteredPools: Math.max(0, prepared.valuedPools - candidates.length),
      selectedPools: positive.length,
      selectedPoolAddresses: positive.map(({ candidate }) => candidate.p.address),
      estimatedRewardUsd: allocations.reduce(
        (sum, allocation) => sum + allocation.estimatedRewardUsd,
        0,
      ),
    },
  };
}

export function optimize(snapshot: Snapshot, policy: Policy): Allocation[] {
  return optimizeDetailed(snapshot, policy).allocations;
}
