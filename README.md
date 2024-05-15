# CoIF -> LSIF

CoIF is not actively developed; you probably want to look at [SCIP](https://sourcegraph.com/github.com/sourcegraph/scip) instead.

The information below is preserved for archival purposes.

---

This converts CoIF to LSIF.

# CoIF

CoIF (Code Index Format) is similar to LSIF, but simpler. It's intended to be a format that is easier for indexers to emit than LSIF. The CoIF to LSIF converter only needs to be written once, so it can save the indexer from needing to be aware of all the nuances of LSIF.

Here's an example of CoIF:

```json
{"symbol":{"range":"0:0-1","hover":"a list -> (a -> b) -> b list","file":"async/src/async.ml"}}
{"references":{"ranges":["1:0-11"],"file":"expect_test_helpers/src/expect_test_helpers.ml"}}
{"references":{"ranges":["3:0-11"],"file":"expect_test_helpers/src/import.ml"}}
{"symbol":{"range":"6:0-1","hover":"a list","file":"async/src/async.ml"}}
{"references":{"ranges":["29:14-22"],"file":"async/src/async.ml"}}
```

The format defines symbols and references to them. Symbols can have metadata attached to them (so far only `hover`).
