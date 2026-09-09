// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAerodromeVoterView {
    function length() external view returns (uint256);
    function pools(uint256 index) external view returns (address);
    function gauges(address pool) external view returns (address);
    function isAlive(address gauge) external view returns (bool);
    function weights(address pool) external view returns (uint256);
    function gaugeToFees(address gauge) external view returns (address);
    function gaugeToBribe(address gauge) external view returns (address);
}

interface IRewardContractView {
    function rewardsListLength() external view returns (uint256);
    function rewards(uint256 index) external view returns (address);
    function tokenRewardsPerEpoch(address token, uint256 epoch) external view returns (uint256);
}

interface IERC20MetadataView {
    function decimals() external view returns (uint8);
}

/// @notice Read-only Aerodrome pool, gauge, reward, and token-decimal view.
/// @dev This contract has no storage, fallback, payable function, or admin.
///      Callers should use small pages because rewards are nested dynamic data.
contract AerodromePoolView {
    error ZeroAddress();

    address public immutable AERODROME_VOTER;

    constructor(address voter_) {
        if (voter_ == address(0)) revert ZeroAddress();
        AERODROME_VOTER = voter_;
    }

    struct Reward {
        address token;
        uint256 amount;
        uint8 decimals;
        bool decimalsValid;
        uint8 source; // 0 = fees, 1 = bribes
    }

    struct PoolInfo {
        address pool;
        address gauge;
        uint256 votes;
        Reward[] rewards;
    }

    /// @notice Return active gauges in the Voter index range [offset, offset+limit).
    /// @dev Rewards without a readable token-decimals method remain in the
    ///      result with decimalsValid=false; callers can value them as unpriced.
    function activePoolsWithRewards(uint256 offset, uint256 limit, uint256 epoch)
        external
        view
        returns (uint256 registeredPools, PoolInfo[] memory pools)
    {
        registeredPools = IAerodromeVoterView(AERODROME_VOTER).length();
        if (limit == 0 || offset >= registeredPools) {
            return (registeredPools, new PoolInfo[](0));
        }

        uint256 end = offset + limit;
        if (end < offset || end > registeredPools) end = registeredPools;
        PoolInfo[] memory result = new PoolInfo[](end - offset);
        uint256 count;

        for (uint256 index = offset; index < end; index++) {
            address pool = IAerodromeVoterView(AERODROME_VOTER).pools(index);
            address gauge = IAerodromeVoterView(AERODROME_VOTER).gauges(pool);
            if (!IAerodromeVoterView(AERODROME_VOTER).isAlive(gauge)) continue;

            address fees = IAerodromeVoterView(AERODROME_VOTER).gaugeToFees(gauge);
            address bribe = IAerodromeVoterView(AERODROME_VOTER).gaugeToBribe(gauge);
            result[count++] = PoolInfo({
                pool: pool,
                gauge: gauge,
                votes: IAerodromeVoterView(AERODROME_VOTER).weights(pool),
                rewards: _rewards(fees, epoch, 0, bribe)
            });
        }

        assembly {
            mstore(result, count)
        }
        return (registeredPools, result);
    }

    function _rewards(address fees, uint256 epoch, uint8 source, address bribe)
        private
        view
        returns (Reward[] memory result)
    {
        uint256 feesLength = _length(fees);
        uint256 bribeLength = _length(bribe);
        result = new Reward[](feesLength + bribeLength);
        uint256 count;
        count = _fill(result, count, fees, feesLength, epoch, source);
        count = _fill(result, count, bribe, bribeLength, epoch, 1);
        assembly {
            mstore(result, count)
        }
    }

    function _length(address rewardContract) private view returns (uint256) {
        if (rewardContract == address(0)) return 0;
        try IRewardContractView(rewardContract).rewardsListLength() returns (uint256 length) {
            return length;
        } catch {
            return 0;
        }
    }

    function _fill(
        Reward[] memory result,
        uint256 count,
        address rewardContract,
        uint256 length,
        uint256 epoch,
        uint8 source
    ) private view returns (uint256) {
        if (rewardContract == address(0)) return count;
        for (uint256 index; index < length; index++) {
            address token;
            try IRewardContractView(rewardContract).rewards(index) returns (address value) {
                token = value;
            } catch {
                continue;
            }
            uint256 amount;
            try IRewardContractView(rewardContract).tokenRewardsPerEpoch(token, epoch) returns (uint256 value) {
                amount = value;
            } catch {
                continue;
            }
            if (amount == 0) continue;
            uint8 decimals;
            bool decimalsValid;
            try IERC20MetadataView(token).decimals() returns (uint8 value) {
                decimals = value;
                decimalsValid = true;
            } catch {}
            result[count++] = Reward(token, amount, decimals, decimalsValid, source);
        }
        return count;
    }
}
