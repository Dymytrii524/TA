// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function eq(uint256 a, uint256 b) internal pure { require(a == b, "ASSERT_EQ"); }
    function ok(bool v) internal pure { require(v, "ASSERT_TRUE"); }
}
