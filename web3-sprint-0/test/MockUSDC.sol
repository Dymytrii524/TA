// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test fixture only. Mint and controls deliberately unrestricted.
contract MockUSDC is ERC20 {
    bool public paused;
    bool public feeEnabled;
    mapping(address => bool) public blocked;
    address public callback;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes4 public callbackError;
    constructor() ERC20("TEST ONLY Mock USDC", "mUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setPaused(bool v) external { paused = v; }
    function setFee(bool v) external { feeEnabled = v; }
    function setBlocked(address a, bool v) external { blocked[a] = v; }
    function setCallback(address a, bytes calldata data) external { callback = a; callbackData = data; }
    function _update(address from, address to, uint256 value) internal override {
        require(!paused && !blocked[from] && !blocked[to], "TOKEN_BLOCKED");
        if (callback != address(0) && from != address(0)) {
            address target = callback;
            callback = address(0);
            bytes memory result;
            (callbackSucceeded,result) = target.call(callbackData);
            if (result.length >= 4) callbackError = bytes4(result);
        }
        if (feeEnabled && from != address(0) && to != address(0) && value > 1) {
            super._update(from, to, value - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, value);
        }
    }
}
