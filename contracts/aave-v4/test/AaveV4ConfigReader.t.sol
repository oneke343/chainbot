// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AaveV4ConfigReader, IHubReader, IInterestReader, ISpokeReader} from "../src/AaveV4ConfigReader.sol";

contract MockMulticall3 {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (results[i].success, results[i].returnData) = calls[i].target.call(calls[i].callData);
            require(calls[i].allowFailure || results[i].success, "Multicall3: call failed");
        }
    }
}

contract MockTokenization {
    uint64 public constant SPOKE_REVISION = 1;
    address public hub;
    constructor(address hub_) { hub = hub_; }
    function assetId() external pure returns (uint256) { return 0; }
    function asset() external pure returns (address) { return address(1); }
    function decimals() external pure returns (uint8) { return 6; }
}

contract MockBrokenExtension {
    function ORACLE() external pure returns (address) { revert("extension probe failed"); }
}

contract MockTreasury {
    uint64 public constant SPOKE_REVISION = 1;
    address public owner = address(0xdead);
    address public pendingOwner;
    function setOwner(address value) external { owner = value; }
}

contract MockAave {
    uint64 public constant SPOKE_REVISION = 1;
    MockTreasury public treasury;
    address public extension = address(0xbeef);
    uint256 public assetCount = 2;
    uint256 public reserveCount = 2;
    uint32 public latestKey = 1;
    uint16 public factor = 8000;
    uint40 public cap = 100;
    bool public revoked;
    bool public adminFunction;
    bool public failDynamic;
    address public managerAuthority;
    bytes4 private constant SELECTOR = bytes4(keccak256("updatePositionManager(address,bool)"));

    constructor() { managerAuthority = address(this); treasury = new MockTreasury(); }
    function setExtension(address value) external { extension = value; }
    function setCap(uint40 value) external { cap = value; }
    function setFactor(uint16 value) external { factor = value; }
    function setLatestKey(uint32 value) external { latestKey = value; }
    function setRevoked(bool value) external { revoked = value; }
    function setAdminFunction(bool value) external { adminFunction = value; }
    function setFailDynamic(bool value) external { failDynamic = value; }
    function setAssetCount(uint256 value) external { assetCount = value; }
    function setReserveCount(uint256 value) external { reserveCount = value; }
    function setAuthority(address value) external { managerAuthority = value; }
    function authority() external view returns (address) { return managerAuthority; }
    function getAssetCount() external view returns (uint256) { return assetCount; }
    function getAssetConfig(uint256) external view returns (IHubReader.AssetConfig memory) {
        return IHubReader.AssetConfig(address(treasury), 1000, address(this), address(0));
    }
    // IDs in this fixture are below 2.
    // forge-lint: disable-next-line(unsafe-typecast)
    function getAssetUnderlyingAndDecimals(uint256 id) external pure returns (address, uint8) { return (address(uint160(id + 1)), 6); }
    function getInterestRateData(uint256) external pure returns (IInterestReader.Config memory) { return IInterestReader.Config(9000, 100, 400, 6000); }
    function getSpokeCount(uint256) external pure returns (uint256) { return 3; }
    function getSpokeAddress(uint256, uint256 index) external view returns (address) { return index == 0 ? address(this) : index == 1 ? address(treasury) : extension; }
    function getSpokeConfig(uint256, address) external view returns (IHubReader.SpokeConfig memory) { return IHubReader.SpokeConfig(cap, 50, 10000, true, false); }
    function ORACLE() external view returns (address) { return address(this); }
    function spoke() external view returns (address) { return address(this); }
    function decimals() external pure returns (uint8) { return 8; }
    function MAX_USER_RESERVES_LIMIT() external pure returns (uint16) { return 16; }
    function getLiquidationLogic() external view returns (address) { return address(this); }
    function getLiquidationConfig() external pure returns (ISpokeReader.LiquidationConfig memory) {
        return ISpokeReader.LiquidationConfig(1.05e18, 0.95e18, 5000);
    }
    function getReserveCount() external view returns (uint256) { return reserveCount; }
    function getReserve(uint256 id) external view returns (ISpokeReader.Reserve memory) {
        // fixture asset IDs are below assetCount=2.
        // forge-lint: disable-next-line(unsafe-typecast)
        return ISpokeReader.Reserve(address(uint160(id + 1)), address(this), uint16(id), 6, 1000, 0, latestKey);
    }
    function getReserveConfig(uint256) external pure returns (ISpokeReader.ReserveConfig memory) { return ISpokeReader.ReserveConfig(1000, false, false, true, true); }
    function getReserveSource(uint256) external pure returns (address) { return address(0xf00d); }
    function getDynamicReserveConfig(uint256, uint32 key) external view returns (ISpokeReader.DynamicConfig memory) {
        require(!failDynamic, "dynamic read failed");
        return ISpokeReader.DynamicConfig(key == 0 ? factor : 8100, 10500, 1000);
    }
    function extSloads(bytes32[] calldata slots) external view returns (bytes32[] memory values) {
        values = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; ++i) { bytes32 slot = slots[i]; bytes32 value; assembly { value := sload(slot) } values[i] = value; }
    }
    function setProxyImplementation(address value) external {
        bytes32 slot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        assembly { sstore(slot, value) }
    }
    function owner() external pure returns (address) { return address(0xdead); }
    function pendingOwner() external pure returns (address) { return address(0); }
    function implementation() external view returns (address) { return address(this); }
    function getRoleCount() external pure returns (uint256) { return 2; }
    function getRole(uint256 index) external pure returns (uint64) { return index == 0 ? 100 : 200; }
    function getRoleAdmin(uint64) external pure returns (uint64) { return 0; }
    function getRoleGuardian(uint64) external pure returns (uint64) { return 0; }
    function getRoleGrantDelay(uint64) external pure returns (uint32) { return 3600; }
    function getRoleMemberCount(uint64 role) external view returns (uint256) {
        require(role != type(uint64).max, "PUBLIC has no enumerated members");
        return !revoked && (role == 0 || role == 100) ? 1 : 0;
    }
    function getRoleMember(uint64, uint256) external pure returns (address) { return address(0xdead); }
    function getAccess(uint64, address) external pure returns (uint48, uint32, uint32, uint48) { return (100, 3600, 0, 0); }
    function getRoleTargetCount(uint64 role) external pure returns (uint256) { require(role != 0, "ADMIN not enumerable"); return 1; }
    function getRoleTarget(uint64 role, uint256) external view returns (address) { return role == type(uint64).max ? address(0xbeef) : address(this); }
    function getRoleTargetSelectorCount(uint64 role, address) external view returns (uint256) { return adminFunction && role == 100 ? 0 : 1; }
    function getRoleTargetSelector(uint64 role, address, uint256) external pure returns (bytes4) {
        return role == type(uint64).max ? bytes4(0x12345678) : role == 200 ? bytes4(0x87654321) : SELECTOR;
    }
    function getTargetFunctionRole(address target, bytes4 selector) external view returns (uint64) {
        if (target == address(0xbeef)) return type(uint64).max;
        if (selector == SELECTOR) return adminFunction ? 0 : 100;
        return 0;
    }
    function isTargetClosed(address) external pure returns (bool) { return false; }
    function getTargetAdminDelay(address) external pure returns (uint32) { return 3600; }
}

contract AaveV4ConfigReaderTest {
    AaveV4ConfigReader private reader;
    MockAave private market;
    function setUp() public { reader = new AaveV4ConfigReader(); market = new MockAave(); }

    function testHubAssetsAndNonLendingSpokes() public view {
        AaveV4ConfigReader.HubGraph memory graph = reader.readHub(address(market));
        AaveV4ConfigReader.Hub memory result = graph.hub;
        require(result.authority == address(market) && result.assets.length == 2);
        require(result.assets[1].assetId == 1 && result.assets[1].decimals == 6);
        require(result.assets[0].registeredSpokes.length == 3 && result.assets[0].registeredSpokes[2].spoke == address(0xbeef));
        require(result.assets[0].registeredSpokes[0].config.addCap == 100);
        require(result.assets[0].interestRate.optimalUsageRatio == 9000);
        require(graph.treasuries.length == 1 && graph.treasuries[0].owner == address(0xdead));
        require(graph.spokes.length == 1 && graph.spokes[0].reserves.length == 2);
        require(graph.otherSpokes.length == 1 && graph.otherSpokes[0].addr == address(0xbeef));
        require(graph.authorities.length == 1 && graph.authorities[0].knownTargets.length == 2);
    }
    function testSpokeReservesAllDynamicKeysAndProxy() public {
        AaveV4ConfigReader.Spoke memory result = reader.readSpoke(address(market));
        require(result.reserves.length == 2 && result.reserves[1].identity.assetId == 1);
        require(result.reserves[0].dynamicConfigs.length == 2 && result.reserves[0].dynamicConfigs[0].collateralFactor == 8000);
        require(result.oracle.decimals == 8 && result.liquidationConfig.targetHealthFactor == 1.05e18);
        market.setProxyImplementation(address(0x123));
        market.setFactor(7900); market.setLatestKey(2);
        result = reader.readSpoke(address(market));
        require(result.reserves[0].dynamicConfigs.length == 3 && result.reserves[0].dynamicConfigs[0].collateralFactor == 7900);
        require(result.proxy.implementation == address(0x123));
    }
    function testAuthoritySpecialRolesMembersAndFunctions() public view {
        AaveV4ConfigReader.Role[] memory roles = reader.readAuthority(address(market));
        require(roles.length == 4 && roles[0].roleId == 0 && roles[1].roleId == type(uint64).max);
        require(roles[0].members.length == 1 && roles[0].targets.length == 0);
        require(roles[1].members.length == 0 && roles[1].targets[0].functions[0].role == type(uint64).max);
        require(roles[2].members[0].currentDelay == 3600 && roles[3].targets[0].configuratorAuthority == address(market));
    }
    function testRevocationAndHistoricalKeyEdits() public {
        market.setRevoked(true); market.setAdminFunction(true);
        AaveV4ConfigReader.Role[] memory roles = reader.readAuthority(address(market));
        require(roles[0].members.length == 0 && roles[2].members.length == 0);
        require(roles[2].targets[0].functions[0].role == 0);
    }
    function testReadFailureRevertsWholeSnapshot() public {
        market.setFailDynamic(true);
        (bool success,) = address(reader).staticcall(abi.encodeCall(reader.readHub, (address(market))));
        require(!success);
    }
    function testTokenizationUsesItsGettersDespiteSharedRevision() public {
        MockTokenization token = new MockTokenization(address(market));
        market.setExtension(address(token));
        AaveV4ConfigReader.HubGraph memory graph = reader.readHub(address(market));
        require(graph.tokenizations.length == 1 && graph.tokenizations[0].hub == address(market));
        require(graph.tokenizations[0].underlying == address(1) && graph.otherSpokes.length == 0);
        require(graph.spokes.length == 1 && graph.treasuries.length == 1);
    }
    function testExtensionProbeErrorsAbortSnapshot() public {
        market.setExtension(address(new MockBrokenExtension()));
        (bool success, bytes memory reason) = address(reader).staticcall(abi.encodeCall(reader.readHub, (address(market))));
        // Compare the selector only.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(!success && bytes4(reason) == AaveV4ConfigReader.InterfaceProbeFailed.selector);
    }
    function testKnownSelectorsUseCanonicalTupleSignatures() public view {
        AaveV4ConfigReader.HubGraph memory graph = reader.readHub(address(market));
        bytes4 hubSelector = bytes4(keccak256("updateAssetConfig(uint256,(address,uint16,address,address),bytes)"));
        bytes4 spokeSelector = bytes4(keccak256("updateLiquidationConfig((uint128,uint64,uint16))"));
        bool foundHub; bool foundSpoke;
        for (uint256 i; i < graph.authorities[0].knownTargets.length; ++i) {
            AaveV4ConfigReader.FunctionRole[] memory functions = graph.authorities[0].knownTargets[i].functions;
            for (uint256 j; j < functions.length; ++j) {
                if (functions[j].selector == hubSelector && functions[j].role == 0) foundHub = true;
                if (functions[j].selector == spokeSelector && functions[j].role == 0) foundSpoke = true;
            }
        }
        require(foundHub && foundSpoke);
    }
    function testEnumerationLimitAndMissingAuthority() public {
        market.setAssetCount(10001);
        (bool success, bytes memory reason) = address(reader).staticcall(abi.encodeCall(reader.readHub, (address(market))));
        // Compare only the four-byte error selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(!success && bytes4(reason) == AaveV4ConfigReader.EnumerationTooLarge.selector);
        market.setAssetCount(2); market.setAuthority(address(0));
        // readAuthority has no managed-address dependency; Hub/Spoke do.
        (success, reason) = address(reader).staticcall(abi.encodeCall(reader.readHub, (address(market))));
        // Compare only the four-byte error selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(!success && bytes4(reason) == AaveV4ConfigReader.MissingAuthority.selector);
    }
}
