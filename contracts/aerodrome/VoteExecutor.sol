// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAerodromeVoter {
    function vote(
        uint256 tokenId,
        address[] calldata pools,
        uint256[] calldata weights
    ) external;
}

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice A deliberately narrow admin-controlled executor for weekly
///         Aerodrome gauge votes.
/// @dev NFT owners approve this contract for individual veAERO NFTs. The admin
///      can forward only vote calls to the fixed Base Voter, rotate the admin,
///      and recover assets accidentally held by this contract.
contract VoteExecutor {
    error Unauthorized();
    error ZeroAddress();
    error EmptyBatch();
    error UnequalLengths();
    error TransferFailed();

    address public constant AERODROME_VOTER =
        0x16613524e02ad97eDfeF371bC883F2F5d6C480A5;
    address public admin;

    event AdminTransferred(
        address indexed previousAdmin,
        address indexed newAdmin
    );
    event ERC20Recovered(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event ETHRecovered(address indexed to, uint256 amount);

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    receive() external payable {}

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    /// @notice Rotate the account authorized to vote and recover assets.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previousAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(previousAdmin, newAdmin);
    }

    /// @notice Recover ERC20 tokens accidentally sent to this executor.
    function recoverERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20Transfer(token).transfer(to, amount)) revert TransferFailed();
        emit ERC20Recovered(token, to, amount);
    }

    /// @notice Recover native ETH accidentally forced into this executor.
    function recoverETH(address payable to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ETHRecovered(to, amount);
    }

    /// @notice Forward several NFT votes in one transaction.
    /// @dev Every NFT must approve this executor. A revert from any vote reverts
    ///      the entire batch, so callers can safely journal one hash per NFT.
    function voteMany(
        uint256[] calldata tokenIds,
        address[][] calldata pools,
        uint256[][] calldata weights
    ) external onlyAdmin {
        if (tokenIds.length == 0) revert EmptyBatch();
        if (tokenIds.length != pools.length || tokenIds.length != weights.length)
            revert UnequalLengths();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (pools[i].length != weights[i].length) revert UnequalLengths();
            IAerodromeVoter(AERODROME_VOTER).vote(
                tokenIds[i],
                pools[i],
                weights[i]
            );
        }
    }
}
