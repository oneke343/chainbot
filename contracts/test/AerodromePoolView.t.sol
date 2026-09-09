// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../aerodrome/AerodromePoolView.sol";

contract ViewMockToken {
    uint8 public immutable tokenDecimals;

    constructor(uint8 decimals_) {
        tokenDecimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return tokenDecimals;
    }
}

contract ViewMockRewards {
    address[] public rewardTokens;
    mapping(address => uint256) public amounts;

    function add(address token, uint256 amount) external {
        rewardTokens.push(token);
        amounts[token] = amount;
    }

    function rewardsListLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    function rewards(uint256 index) external view returns (address) {
        return rewardTokens[index];
    }

    function tokenRewardsPerEpoch(address token, uint256) external view returns (uint256) {
        return amounts[token];
    }
}

contract ViewMockVoter {
    address[] public poolList;
    mapping(address => address) public gauges;
    mapping(address => bool) public alive;
    mapping(address => uint256) public weights;
    mapping(address => address) public gaugeToFees;
    mapping(address => address) public gaugeToBribe;

    function addPool(address pool, address gauge, bool alive_, uint256 votes, address fees, address bribe) external {
        poolList.push(pool);
        gauges[pool] = gauge;
        alive[gauge] = alive_;
        weights[pool] = votes;
        gaugeToFees[gauge] = fees;
        gaugeToBribe[gauge] = bribe;
    }

    function length() external view returns (uint256) {
        return poolList.length;
    }

    function pools(uint256 index) external view returns (address) {
        return poolList[index];
    }

    function isAlive(address gauge) external view returns (bool) {
        return alive[gauge];
    }
}

contract AerodromePoolViewTest {
    function testPageReturnsActiveRewardsAndDecimals() public {
        ViewMockVoter voter = new ViewMockVoter();
        ViewMockRewards fees = new ViewMockRewards();
        ViewMockRewards bribe = new ViewMockRewards();
        ViewMockToken feeToken = new ViewMockToken(6);
        ViewMockToken bribeToken = new ViewMockToken(18);
        fees.add(address(feeToken), 123);
        bribe.add(address(bribeToken), 456);

        address pool = address(0x1001);
        address gauge = address(0x2001);
        voter.addPool(pool, gauge, true, 789, address(fees), address(bribe));
        voter.addPool(address(0x1002), address(0x2002), false, 999, address(0), address(0));

        // The production contract binds the immutable Voter address, so this
        // test deploys the same bytecode with code placed at that address.
        AerodromePoolView reader = new AerodromePoolView(address(voter));
        (uint256 registered, AerodromePoolView.PoolInfo[] memory pools) = reader.activePoolsWithRewards(0, 10, 123);
        require(registered == 2, "registered mismatch");
        require(pools.length == 1, "alive filter mismatch");
        require(pools[0].votes == 789, "votes mismatch");
        require(pools[0].rewards.length == 2, "reward count mismatch");
        require(pools[0].rewards[0].decimalsValid, "fee decimals missing");
        require(pools[0].rewards[0].decimals == 6, "fee decimals mismatch");
        require(pools[0].rewards[1].decimals == 18, "bribe decimals mismatch");
    }
}
