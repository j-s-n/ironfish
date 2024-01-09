/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { blake3 } from '@napi-rs/blake-hash'
import bufio from 'bufio'
import { Assert } from '../assert'
import { BlockHashSerdeInstance, GraffitiSerdeInstance } from '../serde'
import { BigIntUtils } from '../utils/bigint'
import { NoteEncryptedHash, SerializedNoteEncryptedHash } from './noteEncrypted'
import { Target } from './target'
import { Transaction } from './transaction'

export type BlockHash = Buffer

export function hashBlockHeader(serializedHeader: Buffer): BlockHash {
  return blake3(serializedHeader)
}

export function isBlockLater(a: BlockHeader, b: BlockHeader): boolean {
  if (a.sequence !== b.sequence) {
    return a.sequence > b.sequence
  }

  return a.hash.compare(b.hash) < 0
}

export function isBlockHeavier(a: BlockHeader, b: BlockHeader): boolean {
  if (a.work !== b.work) {
    return a.work > b.work
  }

  if (a.sequence !== b.sequence) {
    return a.sequence > b.sequence
  }

  if (a.target.toDifficulty() !== b.target.toDifficulty()) {
    return a.target.toDifficulty() > b.target.toDifficulty()
  }

  return a.hash.compare(b.hash) < 0
}

export const TRANSACTION_ROOT_PERSONALIZATION = Buffer.from('IRON_FISH_TRANSACTION_ROOT')
export const NULL_NODE: Buffer = blake3(Buffer.from([0]))

/**
 * Calculate a commitment to a list of transactions in a block by adding
 * the transaction hashes (including witness data) to a merkle tree and returning the merkle root
 * @param transactions transaction in the block
 * @returns 32-byte commitment to the list of transactions
 */
export function transactionCommitment(transactions: Transaction[]): Buffer {
  const transactionHashes = transactions.map((t) => t.hash())
  return transactionMerkleRoot(transactionHashes)
}

// Implementation similar to ZCash AuthDataMerkleRoot
// https://github.com/zcash/zcash/blob/14cce06163019ab0a16adb944d25f7db68c012c6/src/primitives/block.cpp#L54
export function transactionMerkleRoot(hashes: Buffer[]): Buffer {
  if (hashes.length === 0) {
    return blake3(TRANSACTION_ROOT_PERSONALIZATION)
  }

  // Get the number of nodes needed for a perfectly balanced tree
  const perfectSize = hashes.length === 1 ? 2 : 2 ** Math.ceil(Math.log2(hashes.length))

  Assert.isTrue(perfectSize >= hashes.length)
  Assert.isGreaterThan(perfectSize, 1)
  Assert.isEqual(perfectSize & (perfectSize - 1), 0)

  let currentLevelHashes = hashes
  while (currentLevelHashes.length < perfectSize) {
    currentLevelHashes.push(NULL_NODE)
  }

  Assert.isEqual(perfectSize, currentLevelHashes.length)

  let currentLevel = 0
  while (currentLevelHashes.length > 1) {
    const nextLevelHashes = []
    for (let i = 0; i < currentLevelHashes.length; i += 2) {
      // Add personalization so these hashes cannot be replayed to/from different contexts
      // Also add in the level of the currentLevel to be resilient to second pre-image attacks
      const combination = blake3(
        Buffer.concat([
          TRANSACTION_ROOT_PERSONALIZATION,
          Buffer.from([currentLevel]),
          currentLevelHashes[i],
          currentLevelHashes[i + 1],
        ]),
      )
      nextLevelHashes.push(combination)
    }

    currentLevelHashes = nextLevelHashes
    currentLevel++
  }

  return currentLevelHashes[0]
}

export class BlockHeader {
  /**
   * The sequence number of the block. Blocks in a chain increase in ascending
   * order of sequence. More than one block may have the same sequence,
   * indicating a fork in the chain, but only one fork is selected at a time.
   */
  public readonly sequence: number

  /**
   * The hash of the previous block in the chain
   */
  public readonly previousBlockHash: BlockHash

  /**
   * Commitment (hash) to the note tree after all new notes from transactions in this
   * block have been added to it.
   */
  public readonly noteCommitment: NoteEncryptedHash

  /**
   * Commitment to the set of transactions in this block. Generated by a merkle
   * tree of transaction hashes which include transaction data + witness/signature data.
   */
  public readonly transactionCommitment: Buffer

  /**
   * The hash of the block must be lower than this target value in order for
   * the blocks to be accepted on the chain. Essentially a numerical comparison
   * of a very big integer.
   */
  public readonly target: Target

  /**
   * A value added to the block to try to make it hash to something that is below
   * the target number.
   */
  public readonly randomness: bigint

  /**
   * Unix timestamp according to the miner who mined the block. This value
   * must be taken with a grain of salt, but miners must verify that it is an
   * appropriate distance to the previous blocks timestamp.
   *
   * TODO: this is called timestamp but it's not a timestamp, it's a date.
   * Fix this to be a timestamp or rename it
   */
  public readonly timestamp: Date

  /**
   * A 32 byte field that may be assigned at will by the miner who mined the block.
   */
  public readonly graffiti: Buffer

  /**
   * (For internal uses - excluded when sent over the network)
   * The size of the notes tree after adding transactions from this block.
   */
  public noteSize: number | null

  /**
   * (For internal uses — excluded when sent over the network)
   * Cumulative work from genesis to this block
   */
  public work: bigint

  public readonly hash: Buffer

  constructor(
    sequence: number,
    previousBlockHash: BlockHash,
    noteCommitment: NoteEncryptedHash,
    transactionCommitment: Buffer,
    target: Target,
    randomness = BigInt(0),
    timestamp: Date | undefined = undefined,
    graffiti: Buffer,
    noteSize?: number | null,
    work = BigInt(0),
    hash?: Buffer,
  ) {
    this.sequence = sequence
    this.previousBlockHash = previousBlockHash
    this.noteCommitment = noteCommitment
    this.transactionCommitment = transactionCommitment
    this.target = target
    this.randomness = randomness
    this.timestamp = timestamp || new Date()
    this.graffiti = graffiti
    this.noteSize = noteSize ?? null
    this.work = work
    this.hash = hash || this.computeHash()
  }

  /**
   * Hash all the values in the block header to get a commitment to the entire
   * header and the global trees it models.
   */
  computeHash(): BlockHash {
    const header = this.serialize()

    return hashBlockHeader(header)
  }

  /**
   * Check whether the hash of this block is less than the target stored
   * within the block header. This is the primary proof of work function.
   *
   * Hashes cannot be predicted, and the only way to find one that is lower
   * than the target that is inside it is to tweak the randomness number
   * repeatedly.
   */
  verifyTarget(): boolean {
    return Target.meets(BigIntUtils.fromBytesBE(this.hash), this.target)
  }

  /**
   * Serialize the block header into a buffer for hashing and mining
   */
  serialize(): Buffer {
    const bw = bufio.write(180)
    bw.writeBigU64BE(this.randomness)
    bw.writeU32(this.sequence)
    bw.writeHash(this.previousBlockHash)
    bw.writeHash(this.noteCommitment)
    bw.writeHash(this.transactionCommitment)
    bw.writeBigU256BE(this.target.asBigInt())
    bw.writeU64(this.timestamp.getTime())
    bw.writeBytes(this.graffiti)

    return bw.render()
  }

  equals(other: BlockHeader): boolean {
    return (
      this.noteSize === other.noteSize &&
      this.work === other.work &&
      this.serialize().equals(other.serialize())
    )
  }

  toRaw(): RawBlockHeader {
    return {
      sequence: this.sequence,
      previousBlockHash: this.previousBlockHash,
      noteCommitment: this.noteCommitment,
      transactionCommitment: this.transactionCommitment,
      target: this.target,
      randomness: this.randomness,
      timestamp: this.timestamp,
      graffiti: this.graffiti,
    }
  }

  static fromRaw(raw: RawBlockHeader): BlockHeader {
    return new BlockHeader(
      raw.sequence,
      raw.previousBlockHash,
      raw.noteCommitment,
      raw.transactionCommitment,
      raw.target,
      raw.randomness,
      raw.timestamp,
      raw.graffiti,
    )
  }
}

export type RawBlockHeader = {
  sequence: number
  previousBlockHash: BlockHash
  noteCommitment: NoteEncryptedHash
  transactionCommitment: Buffer
  target: Target
  randomness: bigint
  timestamp: Date
  graffiti: Buffer
}

export type SerializedBlockHeader = {
  sequence: number
  previousBlockHash: string
  noteCommitment: SerializedNoteEncryptedHash
  transactionCommitment: Buffer
  target: string
  randomness: string
  timestamp: number
  noteSize: number | null
  work?: string
  graffiti: string
}

export class BlockHeaderSerde {
  static serialize(header: BlockHeader): SerializedBlockHeader {
    const serialized = {
      sequence: header.sequence,
      previousBlockHash: BlockHashSerdeInstance.serialize(header.previousBlockHash),
      noteCommitment: header.noteCommitment,
      transactionCommitment: header.transactionCommitment,
      target: header.target.targetValue.toString(),
      randomness: header.randomness.toString(),
      timestamp: header.timestamp.getTime(),
      graffiti: GraffitiSerdeInstance.serialize(header.graffiti),
      noteSize: header.noteSize,
      work: header.work.toString(),
    }

    return serialized
  }

  static deserialize(data: SerializedBlockHeader): BlockHeader {
    return new BlockHeader(
      Number(data.sequence),
      Buffer.from(BlockHashSerdeInstance.deserialize(data.previousBlockHash)),
      data.noteCommitment,
      data.transactionCommitment,
      new Target(data.target),
      BigInt(data.randomness),
      new Date(data.timestamp),
      Buffer.from(GraffitiSerdeInstance.deserialize(data.graffiti)),
      data.noteSize,
      data.work ? BigInt(data.work) : BigInt(0),
    )
  }
}
