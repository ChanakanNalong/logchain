// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * LogIntegrity — เก็บ Merkle root ของแต่ละ batch บน Polygon
 *
 * แนวคิด: root ที่ถูก store แล้วห้ามแก้ (immutable)
 * ใครก็ verify ได้ว่า root ตรงกับที่บันทึกไว้ไหม
 */
contract LogIntegrity {
    // bacthId (bytes32) => merkle root (bytes32)
    mapping(bytes32 => bytes32) private roots;
    // bacthId => timestamp muj store
    mapping(bytes32 => uint256) private timestamp;

    address public owner;

    event RootStored(bytes32 indexed bacthId, bytes32 root, uint256 timestamp);

    modifier onlyOwner(){
        require(msg.sender == owner, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

     /**
     * เก็บ Merkle root — เก็บได้ครั้งเดียวต่อ batchId (ป้องกันการแก้ root)
     */
     function storeRoot(bytes32 bacthId, bytes32 root) external onlyOwner {
        require(roots[bacthId] == bytes32(0), "Root already exists");
        roots[bacthId] = root;
        timestamp[bacthId] = block.timestamp;
        emit RootStored(bacthId, root, block.timestamp);
     }

      /**
     * verify ว่า root ที่ส่งมาตรงกับที่บันทึกไว้ไหม
     */
    function verifyRoot(bytes32 bacthId, bytes32 root) external view returns (bool) {
        return roots[bacthId] == root && root != bytes32(0); 
    }

     /**
     * ดึง root + timestamp ของ batch
     */
     function getRoot(bytes32 bacthId) external view returns (bytes32, uint256) {
        return (roots[bacthId], timestamp[bacthId]);
     }
}