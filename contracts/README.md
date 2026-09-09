# Aerodrome VoteExecutor

`VoteExecutor.sol` is a fixed-purpose Base relayer. Its constructor binds one
relayer address; `voteMany` forwards the exact vote calls to the immutable
Aerodrome Voter address. It has no fallback, payable function,
arbitrary call, owner, or upgrade path. `voteMany` is atomic: if any NFT vote
fails, the entire batch reverts.

## Deployment

Review the source and deploy from a separately controlled wallet. With Foundry:

```sh
forge create --root contracts \
  --rpc-url https://mainnet.base.org \
  --private-key "$DEPLOYER_KEY" \
  aerodrome/VoteExecutor.sol:VoteExecutor \
  --constructor-args <RELAYER_ADDRESS>
```

Do not put the deployer key in Windmill. After deployment, verify the returned
address, `relayer()`, and `AERODROME_VOTER()` on Base.

For every veAERO NFT, the owner must externally call
`VotingEscrow.approve(<EXECUTOR_ADDRESS>, <TOKEN_ID>)`. This is per-token
authorization; do not use `setApprovalForAll` unless that broader permission is
intended. Revoke it with `approve(address(0), <TOKEN_ID>)`.

Configure the Windmill Flow with `voteExecutor`, `relayerAddress`, the relayer
Secret Variable path, and optionally `executorBatchSize` (1–50, default 16).
Every transaction uses the executor's atomic `voteMany` entrypoint; a value of
1 creates a one-item batch through that same entrypoint. Run a dry-run first.
