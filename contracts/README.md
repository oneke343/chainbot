# Aerodrome VoteExecutor

`VoteExecutor.sol` is a fixed-purpose Base admin. Its constructor binds one
admin address; `voteMany` forwards the exact vote calls to the immutable
Aerodrome Voter address. It has no fallback, arbitrary call, owner, or upgrade
path. It accepts native ETH for operational recovery, but has no other payable
entrypoint. `voteMany` is atomic: if any NFT vote fails, the entire batch
reverts.

## Deployment

Review the source and deploy from a separately controlled wallet. With Foundry:

```sh
forge create --root contracts \
  --rpc-url https://mainnet.base.org \
  --private-key "$DEPLOYER_KEY" \
  aerodrome/VoteExecutor.sol:VoteExecutor \
  --constructor-args <ADMIN_ADDRESS>
```

Do not put the deployer key in Windmill. After deployment, verify the returned
address, `admin()`, and `AERODROME_VOTER()` on Base.

For every veAERO NFT, the owner must externally call
`VotingEscrow.approve(<EXECUTOR_ADDRESS>, <TOKEN_ID>)`. This is per-token
authorization; do not use `setApprovalForAll` unless that broader permission is
intended. Revoke it with `approve(address(0), <TOKEN_ID>)`.

Configure the Windmill Flow with `voteExecutor`, `adminAddress`, the admin
Secret Variable path, and optionally `executorBatchSize` (1–50, default 16).
Every transaction uses the executor's atomic `voteMany` entrypoint; a value of
1 creates a one-item batch through that same entrypoint. Run a dry-run first.

The admin can rotate its key with `transferAdmin(newAdmin)`. It can also
recover ERC20 tokens with `recoverERC20(token, to, amount)` and forced native
ETH with `recoverETH(to, amount)`. These recovery methods do not provide an
arbitrary-call surface.

## AerodromePoolView

`AerodromePoolView.sol` is a read-only Base aggregator. Its
`activePoolsWithRewards(offset, limit, epoch)` method filters the fixed
Aerodrome Voter directory to live gauges and returns pool addresses, gauges,
weights, positive fee/bribe rewards, and each reward token's decimals in one
paginated result. It has no storage, fallback, payable function, admin, or
upgrade path.

Deploy it once with the Aerodrome Voter address:

```sh
forge create --root contracts \
  --rpc-url https://mainnet.base.org \
  --private-key "$DEPLOYER_KEY" \
  aerodrome/AerodromePoolView.sol:AerodromePoolView \
  --constructor-args 0x16613524e02ad97eDfeF371bC883F2F5d6C480A5
```

Set the resulting address as the Flow's `poolViewAddress`. The default page
size is 100 Voter indexes; use `poolViewPageSize` between 10 and 100 when
benchmarking the RPC provider. Windmill still obtains token prices off-chain;
token decimals no longer require separate RPC reads on this path.
