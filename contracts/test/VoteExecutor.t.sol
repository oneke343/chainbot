// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../aerodrome/VoteExecutor.sol";

contract UnauthorizedCaller {
    function callExecutorMany(
        VoteExecutor executor,
        uint256[] memory tokenIds,
        address[][] memory pools,
        uint256[][] memory weights
    ) external {
        executor.voteMany(tokenIds, pools, weights);
    }
}

contract VoteExecutorTest {
    function testConstructorStoresRelayer() public {
        VoteExecutor executor = new VoteExecutor(address(this));
        require(executor.relayer() == address(this), "relayer mismatch");
        require(
            executor.AERODROME_VOTER() ==
                0x16613524e02ad97eDfeF371bC883F2F5d6C480A5,
            "voter mismatch"
        );
    }

    function testUnauthorizedVoteManyReverts() public {
        VoteExecutor executor = new VoteExecutor(address(this));
        UnauthorizedCaller caller = new UnauthorizedCaller();
        uint256[] memory tokenIds = new uint256[](1);
        address[][] memory pools = new address[][](1);
        uint256[][] memory weights = new uint256[][](1);
        bool reverted;
        try caller.callExecutorMany(executor, tokenIds, pools, weights) {
        } catch {
            reverted = true;
        }
        require(reverted, "expected unauthorized batch revert");
    }
}
