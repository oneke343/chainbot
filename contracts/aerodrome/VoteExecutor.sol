// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAerodromeVoter {
    function vote(
        uint256 tokenId,
        address[] calldata pools,
        uint256[] calldata weights
    ) external;
}

/// @notice A deliberately narrow relayer for weekly Aerodrome gauge votes.
/// @dev The owner approves this contract for individual veAERO NFTs. The only
///      callable operation is forwarding protocol vote calls to the fixed Base
///      Voter through the atomic voteMany entrypoint.
///      There is no fallback, ETH custody, arbitrary call, admin, or upgrade.
contract VoteExecutor {
    error Unauthorized();
    error ZeroAddress();
    error EmptyBatch();
    error UnequalLengths();

    address public constant AERODROME_VOTER =
        0x16613524e02ad97eDfeF371bC883F2F5d6C480A5;
    address public immutable relayer;

    constructor(address relayer_) {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
    }

    /// @notice Forward several NFT votes in one transaction.
    /// @dev Every NFT must approve this executor. A revert from any vote reverts
    ///      the entire batch, so callers can safely journal one hash per NFT.
    function voteMany(
        uint256[] calldata tokenIds,
        address[][] calldata pools,
        uint256[][] calldata weights
    ) external {
        if (msg.sender != relayer) revert Unauthorized();
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
