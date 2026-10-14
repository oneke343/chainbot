// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// These read-only interfaces mirror official getters. Only ERC-1967 standardized slots are used, through Spoke.extSloads.
interface IManaged {
    function authority() external view returns (address);
}
interface IHubReader is IManaged {
    struct AssetConfig { address feeReceiver; uint16 liquidityFee; address irStrategy; address reinvestmentController; }
    struct SpokeConfig { uint40 addCap; uint40 drawCap; uint24 riskPremiumThreshold; bool active; bool halted; }
    function getAssetCount() external view returns (uint256);
    function getAssetConfig(uint256) external view returns (AssetConfig memory);
    function getAssetUnderlyingAndDecimals(uint256) external view returns (address, uint8);
    function getSpokeCount(uint256) external view returns (uint256);
    function getSpokeAddress(uint256, uint256) external view returns (address);
    function getSpokeConfig(uint256, address) external view returns (SpokeConfig memory);
}
interface IInterestReader {
    struct Config { uint16 optimalUsageRatio; uint32 baseDrawnRate; uint32 rateGrowthBeforeOptimal; uint32 rateGrowthAfterOptimal; }
    function getInterestRateData(uint256) external view returns (Config memory);
}
interface ISpokeReader is IManaged {
    struct Reserve { address underlying; address hub; uint16 assetId; uint8 decimals; uint24 collateralRisk; uint8 flags; uint32 dynamicConfigKey; }
    struct ReserveConfig { uint24 collateralRisk; bool paused; bool frozen; bool borrowable; bool receiveSharesEnabled; }
    struct DynamicConfig { uint16 collateralFactor; uint32 maxLiquidationBonus; uint16 liquidationFee; }
    struct LiquidationConfig { uint128 targetHealthFactor; uint64 healthFactorForMaxBonus; uint16 liquidationBonusFactor; }
    function ORACLE() external view returns (address);
    function MAX_USER_RESERVES_LIMIT() external view returns (uint16);
    function getLiquidationLogic() external view returns (address);
    function getLiquidationConfig() external view returns (LiquidationConfig memory);
    function getReserveCount() external view returns (uint256);
    function getReserve(uint256) external view returns (Reserve memory);
    function getReserveConfig(uint256) external view returns (ReserveConfig memory);
    function getDynamicReserveConfig(uint256, uint32) external view returns (DynamicConfig memory);
    function extSloads(bytes32[] calldata) external view returns (bytes32[] memory);
}
interface IOracleReader {
    function spoke() external view returns (address);
    function decimals() external view returns (uint8);
    function getReserveSource(uint256) external view returns (address);
}
interface ITreasuryReader {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
}
interface IAuthorityReader {
    function getRoleCount() external view returns (uint256);
    function getRole(uint256) external view returns (uint64);
    function getRoleAdmin(uint64) external view returns (uint64);
    function getRoleGuardian(uint64) external view returns (uint64);
    function getRoleGrantDelay(uint64) external view returns (uint32);
    function getRoleMemberCount(uint64) external view returns (uint256);
    function getRoleMember(uint64, uint256) external view returns (address);
    function getAccess(uint64, address) external view returns (uint48, uint32, uint32, uint48);
    function getRoleTargetCount(uint64) external view returns (uint256);
    function getRoleTarget(uint64, uint256) external view returns (address);
    function getRoleTargetSelectorCount(uint64, address) external view returns (uint256);
    function getRoleTargetSelector(uint64, address, uint256) external view returns (bytes4);
    function getTargetFunctionRole(address, bytes4) external view returns (uint64);
    function isTargetClosed(address) external view returns (bool);
    function getTargetAdminDelay(address) external view returns (uint32);
}

interface ITokenizationReader {
    function hub() external view returns (address);
    function assetId() external view returns (uint256);
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
}
interface IOwnerReader { function owner() external view returns (address); }
interface IBeaconReader { function implementation() external view returns (address); }

contract AaveV4ConfigReader {
    uint256 private constant MAX_ENUMERATION = 10_000;
    error EnumerationTooLarge(uint256 count);
    error MissingAuthority(address target);
    error InterfaceProbeFailed(address target, bytes4 selector);
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 private constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
    bytes32 private constant BEACON_SLOT = bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1);

    struct ContractInfo { address addr; bytes32 codeHash; }
    struct RegisteredSpoke { address spoke; IHubReader.SpokeConfig config; }
    struct Asset {
        uint256 assetId;
        address underlying;
        uint8 decimals;
        bytes32 underlyingCodeHash;
        IHubReader.AssetConfig config;
        IInterestReader.Config interestRate;
        bytes32 irStrategyCodeHash;
        bytes32 reinvestmentControllerCodeHash;
        RegisteredSpoke[] registeredSpokes;
    }
    struct Hub { address addr; bytes32 codeHash; address authority; Asset[] assets; }
    struct Reserve {
        uint256 reserveId;
        ISpokeReader.Reserve identity;
        ISpokeReader.ReserveConfig config;
        address priceSource;
        bytes32 priceSourceCodeHash;
        ISpokeReader.DynamicConfig[] dynamicConfigs;
    }
    struct Oracle { address addr; bytes32 codeHash; address spoke; uint8 decimals; }
    struct Proxy {
        address implementation; bytes32 implementationCodeHash;
        address admin; bytes32 adminCodeHash; bool adminOwnable; address adminOwner;
        address beacon; bytes32 beaconCodeHash; bool beaconOwnable; address beaconOwner;
        address beaconImplementation; bytes32 beaconImplementationCodeHash;
    }
    struct Spoke {
        address addr; bytes32 codeHash; address authority;
        Oracle oracle;
        uint16 maxUserReservesLimit;
        address liquidationLogic; bytes32 liquidationLogicCodeHash;
        ISpokeReader.LiquidationConfig liquidationConfig;
        Reserve[] reserves;
        Proxy proxy;
    }
    struct Treasury { address addr; bytes32 codeHash; address owner; address pendingOwner; }
    struct Tokenization { address addr; bytes32 codeHash; address hub; uint256 assetId; address underlying; uint8 decimals; }
    struct Member { address account; uint48 since; uint32 currentDelay; uint32 pendingDelay; uint48 effect; }
    struct FunctionRole { bytes4 selector; uint64 role; }
    struct Target {
        address target; bytes32 codeHash; bool closed; uint32 adminDelay;
        address configuratorAuthority;
        FunctionRole[] functions;
    }
    struct Role { uint64 roleId; uint64 admin; uint64 guardian; uint32 grantDelay; Member[] members; Target[] targets; }
    struct Authority { address addr; bytes32 codeHash; bool enumerable; Role[] roles; Target[] knownTargets; }
    struct HubGraph { Hub hub; Spoke[] spokes; Treasury[] treasuries; Tokenization[] tokenizations; ContractInfo[] otherSpokes; Authority[] authorities; }

    function readHub(address address_) external view returns (HubGraph memory result) {
        result.hub = _readHubConfig(address_);
        address[] memory listed = new address[](0);
        for (uint256 id; id < result.hub.assets.length; ++id) {
            RegisteredSpoke[] memory registrations = result.hub.assets[id].registeredSpokes;
            for (uint256 j; j < registrations.length; ++j) listed = _appendUnique(listed, registrations[j].spoke);
        }
        result.spokes = new Spoke[](listed.length);
        result.treasuries = new Treasury[](listed.length);
        result.tokenizations = new Tokenization[](listed.length);
        result.otherSpokes = new ContractInfo[](listed.length);
        uint256 spokes; uint256 treasuries; uint256 tokenizations; uint256 others;
        for (uint256 i; i < listed.length; ++i) {
            address target = listed[i];
            // Revision getters identify the official instance types. Unknown extensions keep their registration and code identity.
            if (_supports(target, ISpokeReader.ORACLE.selector)) result.spokes[spokes++] = _readSpoke(target);
            else if (_supports(target, ITreasuryReader.owner.selector) && _supports(target, ITreasuryReader.pendingOwner.selector)) {
                result.treasuries[treasuries++] = Treasury(target, target.codehash, ITreasuryReader(target).owner(), ITreasuryReader(target).pendingOwner());
            } else if (_supports(target, ITokenizationReader.hub.selector)) {
                ITokenizationReader token = ITokenizationReader(target);
                result.tokenizations[tokenizations++] = Tokenization(target, target.codehash, token.hub(), token.assetId(), token.asset(), token.decimals());
            } else result.otherSpokes[others++] = ContractInfo(target, target.codehash);
        }
        // Shrink the populated prefixes; all objects are constructed before the length changes.
        assembly ("memory-safe") {
            mstore(mload(add(result, 0x20)), spokes)
            mstore(mload(add(result, 0x40)), treasuries)
            mstore(mload(add(result, 0x60)), tokenizations)
            mstore(mload(add(result, 0x80)), others)
        }
        result.authorities = _readAuthorities(result.hub, result.spokes);
    }

    function _readHubConfig(address address_) private view returns (Hub memory result) {
        IHubReader hub = IHubReader(address_);
        result.addr = address_; result.codeHash = address_.codehash; result.authority = _authority(address_);
        result.assets = new Asset[](_count(hub.getAssetCount()));
        for (uint256 id; id < result.assets.length; ++id) {
            Asset memory asset;
            asset.assetId = id;
            (asset.underlying, asset.decimals) = hub.getAssetUnderlyingAndDecimals(id);
            asset.underlyingCodeHash = asset.underlying.codehash;
            asset.config = hub.getAssetConfig(id);
            asset.interestRate = IInterestReader(asset.config.irStrategy).getInterestRateData(id);
            asset.irStrategyCodeHash = asset.config.irStrategy.codehash;
            asset.reinvestmentControllerCodeHash = asset.config.reinvestmentController.codehash;
            asset.registeredSpokes = new RegisteredSpoke[](_count(hub.getSpokeCount(id)));
            for (uint256 index; index < asset.registeredSpokes.length; ++index) {
                address spoke = hub.getSpokeAddress(id, index);
                asset.registeredSpokes[index] = RegisteredSpoke(spoke, hub.getSpokeConfig(id, spoke));
            }
            result.assets[id] = asset;
        }
    }

    function readSpoke(address address_) external view returns (Spoke memory) { return _readSpoke(address_); }
    function _readSpoke(address address_) private view returns (Spoke memory result) {
        ISpokeReader spoke = ISpokeReader(address_);
        result.addr = address_; result.codeHash = address_.codehash; result.authority = _authority(address_);
        address oracleAddress = spoke.ORACLE();
        IOracleReader oracle = IOracleReader(oracleAddress);
        result.oracle = Oracle(oracleAddress, oracleAddress.codehash, oracle.spoke(), oracle.decimals());
        result.maxUserReservesLimit = spoke.MAX_USER_RESERVES_LIMIT();
        result.liquidationLogic = spoke.getLiquidationLogic();
        result.liquidationLogicCodeHash = result.liquidationLogic.codehash;
        result.liquidationConfig = spoke.getLiquidationConfig();
        result.reserves = new Reserve[](_count(spoke.getReserveCount()));
        for (uint256 id; id < result.reserves.length; ++id) {
            Reserve memory reserve;
            reserve.reserveId = id; reserve.identity = spoke.getReserve(id); reserve.config = spoke.getReserveConfig(id);
            reserve.priceSource = oracle.getReserveSource(id); reserve.priceSourceCodeHash = reserve.priceSource.codehash;
            reserve.dynamicConfigs = new ISpokeReader.DynamicConfig[](_count(uint256(reserve.identity.dynamicConfigKey) + 1));
            for (uint256 key; key < reserve.dynamicConfigs.length; ++key) {
                // Every key is below MAX_ENUMERATION and fits uint32.
                // forge-lint: disable-next-line(unsafe-typecast)
                reserve.dynamicConfigs[key] = spoke.getDynamicReserveConfig(id, uint32(key));
            }
            result.reserves[id] = reserve;
        }
        bytes32[] memory slots = new bytes32[](3); slots[0] = IMPLEMENTATION_SLOT; slots[1] = ADMIN_SLOT; slots[2] = BEACON_SLOT;
        bytes32[] memory values = spoke.extSloads(slots);
        require(values.length == 3, "invalid proxy slots");
        Proxy memory proxy;
        proxy.implementation = _slotAddress(values[0]); proxy.implementationCodeHash = proxy.implementation.codehash;
        proxy.admin = _slotAddress(values[1]); proxy.adminCodeHash = proxy.admin.codehash;
        (proxy.adminOwnable, proxy.adminOwner) = _optionalOwner(proxy.admin);
        proxy.beacon = _slotAddress(values[2]); proxy.beaconCodeHash = proxy.beacon.codehash;
        (proxy.beaconOwnable, proxy.beaconOwner) = _optionalOwner(proxy.beacon);
        if (proxy.beacon != address(0)) {
            proxy.beaconImplementation = IBeaconReader(proxy.beacon).implementation();
            proxy.beaconImplementationCodeHash = proxy.beaconImplementation.codehash;
        }
        result.proxy = proxy;
    }

    function readAuthority(address address_) external view returns (Role[] memory) { return _roles(address_); }
    function _readAuthorities(Hub memory hub, Spoke[] memory spokes) private view returns (Authority[] memory result) {
        address[] memory addresses = new address[](0);
        addresses = _appendUnique(addresses, hub.authority);
        for (uint256 i; i < spokes.length; ++i) addresses = _appendUnique(addresses, spokes[i].authority);
        result = new Authority[](0);
        for (uint256 i; i < addresses.length; ++i) {
            Authority memory item;
            item.addr = addresses[i]; item.codeHash = item.addr.codehash;
            item.enumerable = _supports(item.addr, IAuthorityReader.getRoleCount.selector);
            if (item.enumerable) item.roles = _roles(item.addr);
            uint256 n = hub.authority == item.addr ? 1 : 0;
            for (uint256 j; j < spokes.length; ++j) if (spokes[j].authority == item.addr) ++n;
            item.knownTargets = new Target[](n);
            n = 0;
            if (hub.authority == item.addr) item.knownTargets[n++] = _target(IAuthorityReader(item.addr), hub.addr, _selectors(1));
            for (uint256 j; j < spokes.length; ++j) if (spokes[j].authority == item.addr) item.knownTargets[n++] = _target(IAuthorityReader(item.addr), spokes[j].addr, _selectors(3));
            for (uint256 j; j < item.roles.length; ++j) for (uint256 k; k < item.roles[j].targets.length; ++k) {
                address next = item.roles[j].targets[k].configuratorAuthority;
                if (next != address(0)) addresses = _appendUnique(addresses, next);
            }
            Authority[] memory extended = new Authority[](result.length + 1);
            for (uint256 j; j < result.length; ++j) extended[j] = result[j];
            extended[result.length] = item; result = extended;
        }
    }
    function _roles(address address_) private view returns (Role[] memory result) {
        IAuthorityReader authority = IAuthorityReader(address_);
        uint256 count = _count(authority.getRoleCount());
        result = new Role[](count + 2);
        result[0] = _role(authority, 0); result[1] = _role(authority, type(uint64).max);
        for (uint256 index; index < count; ++index) result[index + 2] = _role(authority, authority.getRole(index));
    }
    function _role(IAuthorityReader authority, uint64 id) private view returns (Role memory result) {
        result.roleId = id; result.admin = authority.getRoleAdmin(id); result.guardian = authority.getRoleGuardian(id); result.grantDelay = authority.getRoleGrantDelay(id);
        if (id != type(uint64).max) {
            result.members = new Member[](_count(authority.getRoleMemberCount(id)));
            for (uint256 index; index < result.members.length; ++index) {
                address account = authority.getRoleMember(id, index);
                (uint48 since, uint32 currentDelay, uint32 pendingDelay, uint48 effect) = authority.getAccess(id, account);
                result.members[index] = Member(account, since, currentDelay, pendingDelay, effect);
            }
        }
        if (id == 0) return result;
        result.targets = new Target[](_count(authority.getRoleTargetCount(id)));
        for (uint256 index; index < result.targets.length; ++index) {
            address target = authority.getRoleTarget(id, index);
            bytes4[] memory selectors = new bytes4[](_count(authority.getRoleTargetSelectorCount(id, target)));
            for (uint256 j; j < selectors.length; ++j) selectors[j] = authority.getRoleTargetSelector(id, target, j);
            // Enumerated targets in official namespaces are augmented with known selectors, including default ADMIN permissions.
            // Dividing a role below 500 by 100 produces a value below 5.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 kind = id < 500 ? uint8(id / 100) : 0;
            bytes4[] memory known = _selectors(kind);
            bytes4[] memory all = new bytes4[](selectors.length + known.length);
            uint256 n;
            for (uint256 j; j < selectors.length; ++j) all[n++] = selectors[j];
            for (uint256 j; j < known.length; ++j) {
                bool exists; for (uint256 k; k < selectors.length; ++k) if (selectors[k] == known[j]) exists = true;
                if (!exists) all[n++] = known[j];
            }
            assembly ("memory-safe") { mstore(all, n) }
            result.targets[index] = _target(authority, target, all);
            if (kind == 2 || kind == 4) result.targets[index].configuratorAuthority = _authority(target);
        }
    }
    function _target(IAuthorityReader authority, address address_, bytes4[] memory selectors) private view returns (Target memory result) {
        result.target = address_; result.codeHash = address_.codehash;
        result.closed = authority.isTargetClosed(address_); result.adminDelay = authority.getTargetAdminDelay(address_);
        result.functions = new FunctionRole[](selectors.length);
        for (uint256 i; i < selectors.length; ++i) result.functions[i] = FunctionRole(selectors[i], authority.getTargetFunctionRole(address_, selectors[i]));
    }
    function _authority(address target) private view returns (address result) {
        result = IManaged(target).authority(); if (result == address(0)) revert MissingAuthority(target);
    }
    function _count(uint256 count) private pure returns (uint256) { if (count > MAX_ENUMERATION) revert EnumerationTooLarge(count); return count; }
    function _appendUnique(address[] memory values, address value) private pure returns (address[] memory result) {
        for (uint256 i; i < values.length; ++i) if (values[i] == value) return values;
        result = new address[](_count(values.length + 1));
        for (uint256 i; i < values.length; ++i) result[i] = values[i];
        result[values.length] = value;
    }
    function _supports(address target, bytes4 selector) private view returns (bool) {
        if (target.code.length == 0) return false;
        uint256 beforeGas = gasleft();
        // Ensure EIP-150 can forward the full probe budget; low gas must not look like a missing getter.
        if (beforeGas < 35_000) revert InterfaceProbeFailed(target, selector);
        (bool success, bytes memory data) = target.staticcall{gas: 30_000}(abi.encodeWithSelector(selector));
        if (success) {
            if (data.length != 32) revert InterfaceProbeFailed(target, selector);
            return true;
        }
        // A missing selector normally reverts empty. Nonempty errors and exhausted probe budgets are not unsupported interfaces.
        if (data.length != 0 || beforeGas - gasleft() >= 30_000) revert InterfaceProbeFailed(target, selector);
        return false;
    }
    function _optionalOwner(address target) private view returns (bool supported, address owner) {
        if (!_supports(target, IOwnerReader.owner.selector)) return (false, address(0));
        return (true, IOwnerReader(target).owner());
    }
    function _slotAddress(bytes32 value) private pure returns (address) {
        // ERC-1967 address slots contain a zero-padded 160-bit address.
        require(uint256(value) >> 160 == 0, "invalid address slot");
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(value)));
    }
    // Canonical signatures from the official IHub/ISpoke and Configurator interfaces.
    function _selectors(uint8 kind) private pure returns (bytes4[] memory result) {
        if (kind == 1) {
            result = new bytes4[](8);
            result[0] = bytes4(keccak256("addAsset(address,uint8,address,address,bytes)"));
            result[1] = bytes4(keccak256("updateAssetConfig(uint256,(address,uint16,address,address),bytes)"));
            result[2] = bytes4(keccak256("addSpoke(uint256,address,(uint40,uint40,uint24,bool,bool))"));
            result[3] = bytes4(keccak256("updateSpokeConfig(uint256,address,(uint40,uint40,uint24,bool,bool))"));
            result[4] = bytes4(keccak256("setInterestRateData(uint256,bytes)"));
            result[5] = bytes4(keccak256("mintFeeShares(uint256)"));
            result[6] = bytes4(keccak256("eliminateDeficit(uint256,uint256,address)"));
            result[7] = bytes4(keccak256("setAuthority(address)"));
            return result;
        }
        if (kind == 2) {
            result = new bytes4[](23);
            result[0] = bytes4(keccak256("addAsset(address,address,address,uint256,address,bytes)"));
            result[1] = bytes4(keccak256("addAssetWithDecimals(address,address,uint8,address,uint256,address,bytes)"));
            result[2] = bytes4(keccak256("updateLiquidityFee(address,uint256,uint256)"));
            result[3] = bytes4(keccak256("updateFeeReceiver(address,uint256,address)"));
            result[4] = bytes4(keccak256("updateFeeConfig(address,uint256,uint256,address)"));
            result[5] = bytes4(keccak256("updateInterestRateStrategy(address,uint256,address,bytes)"));
            result[6] = bytes4(keccak256("updateReinvestmentController(address,uint256,address)"));
            result[7] = bytes4(keccak256("resetAssetCaps(address,uint256)"));
            result[8] = bytes4(keccak256("deactivateAsset(address,uint256)"));
            result[9] = bytes4(keccak256("haltAsset(address,uint256)"));
            result[10] = bytes4(keccak256("addSpoke(address,address,uint256,(uint40,uint40,uint24,bool,bool))"));
            result[11] = bytes4(keccak256("addSpokeToAssets(address,address,uint256[],(uint40,uint40,uint24,bool,bool)[])"));
            result[12] = bytes4(keccak256("updateSpokeActive(address,uint256,address,bool)"));
            result[13] = bytes4(keccak256("updateSpokeHalted(address,uint256,address,bool)"));
            result[14] = bytes4(keccak256("updateSpokeAddCap(address,uint256,address,uint256)"));
            result[15] = bytes4(keccak256("updateSpokeDrawCap(address,uint256,address,uint256)"));
            result[16] = bytes4(keccak256("updateSpokeRiskPremiumThreshold(address,uint256,address,uint256)"));
            result[17] = bytes4(keccak256("updateSpokeCaps(address,uint256,address,uint256,uint256)"));
            result[18] = bytes4(keccak256("deactivateSpoke(address,address)"));
            result[19] = bytes4(keccak256("haltSpoke(address,address)"));
            result[20] = bytes4(keccak256("resetSpokeCaps(address,address)"));
            result[21] = bytes4(keccak256("updateInterestRateData(address,uint256,bytes)"));
            result[22] = bytes4(keccak256("setAuthority(address)"));
            return result;
        }
        if (kind == 3) {
            result = new bytes4[](10);
            result[0] = bytes4(keccak256("updateLiquidationConfig((uint128,uint64,uint16))"));
            result[1] = bytes4(keccak256("addReserve(address,uint256,address,(uint24,bool,bool,bool,bool),(uint16,uint32,uint16))"));
            result[2] = bytes4(keccak256("updateReserveConfig(uint256,(uint24,bool,bool,bool,bool))"));
            result[3] = bytes4(keccak256("updateReservePriceSource(uint256,address)"));
            result[4] = bytes4(keccak256("addDynamicReserveConfig(uint256,(uint16,uint32,uint16))"));
            result[5] = bytes4(keccak256("updateDynamicReserveConfig(uint256,uint32,(uint16,uint32,uint16))"));
            result[6] = bytes4(keccak256("updatePositionManager(address,bool)"));
            result[7] = bytes4(keccak256("updateUserRiskPremium(address)"));
            result[8] = bytes4(keccak256("updateUserDynamicConfig(address)"));
            result[9] = bytes4(keccak256("setAuthority(address)"));
            return result;
        }
        if (kind == 4) {
            result = new bytes4[](25);
            result[0] = bytes4(keccak256("updateReservePriceSource(address,uint256,address)"));
            result[1] = bytes4(keccak256("updateLiquidationTargetHealthFactor(address,uint256)"));
            result[2] = bytes4(keccak256("updateHealthFactorForMaxBonus(address,uint256)"));
            result[3] = bytes4(keccak256("updateLiquidationBonusFactor(address,uint256)"));
            result[4] = bytes4(keccak256("updateLiquidationConfig(address,(uint128,uint64,uint16))"));
            result[5] = bytes4(keccak256("addReserve(address,address,uint256,address,(uint24,bool,bool,bool,bool),(uint16,uint32,uint16))"));
            result[6] = bytes4(keccak256("updatePaused(address,uint256,bool)"));
            result[7] = bytes4(keccak256("updateFrozen(address,uint256,bool)"));
            result[8] = bytes4(keccak256("updateBorrowable(address,uint256,bool)"));
            result[9] = bytes4(keccak256("updateReceiveSharesEnabled(address,uint256,bool)"));
            result[10] = bytes4(keccak256("updateCollateralRisk(address,uint256,uint256)"));
            result[11] = bytes4(keccak256("addCollateralFactor(address,uint256,uint16)"));
            result[12] = bytes4(keccak256("updateCollateralFactor(address,uint256,uint32,uint16)"));
            result[13] = bytes4(keccak256("addMaxLiquidationBonus(address,uint256,uint256)"));
            result[14] = bytes4(keccak256("updateMaxLiquidationBonus(address,uint256,uint32,uint256)"));
            result[15] = bytes4(keccak256("addLiquidationFee(address,uint256,uint256)"));
            result[16] = bytes4(keccak256("updateLiquidationFee(address,uint256,uint32,uint256)"));
            result[17] = bytes4(keccak256("addDynamicReserveConfig(address,uint256,(uint16,uint32,uint16))"));
            result[18] = bytes4(keccak256("updateDynamicReserveConfig(address,uint256,uint32,(uint16,uint32,uint16))"));
            result[19] = bytes4(keccak256("pauseAllReserves(address)"));
            result[20] = bytes4(keccak256("freezeAllReserves(address)"));
            result[21] = bytes4(keccak256("pauseReserve(address,uint256)"));
            result[22] = bytes4(keccak256("freezeReserve(address,uint256)"));
            result[23] = bytes4(keccak256("updatePositionManager(address,address,bool)"));
            result[24] = bytes4(keccak256("setAuthority(address)"));
            return result;
        }
        return new bytes4[](0);
    }
}
