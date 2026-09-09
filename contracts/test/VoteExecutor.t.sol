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

contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract VoteExecutorTest {
    function testConstructorStoresAdmin() public {
        VoteExecutor executor = new VoteExecutor(address(this));
        require(executor.admin() == address(this), "admin mismatch");
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

    function testAdminCanTransferAdmin() public {
        VoteExecutor executor = new VoteExecutor(address(this));
        address nextAdmin = address(1234);
        executor.transferAdmin(nextAdmin);
        require(executor.admin() == nextAdmin, "admin not transferred");
    }

    function testAdminCanRecoverERC20() public {
        VoteExecutor executor = new VoteExecutor(address(this));
        MockERC20 token = new MockERC20();
        token.mint(address(executor), 100);
        executor.recoverERC20(address(token), address(this), 40);
        require(token.balanceOf(address(executor)) == 60, "executor balance mismatch");
        require(token.balanceOf(address(this)) == 40, "recipient balance mismatch");
    }
}
