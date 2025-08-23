# Synthetic Publisher CLI

Usage examples:

- Webhook mode (PRNewswire):

node ./tools/synth-publisher/cli.js --mode webhook --provider prnewswire --rps 0.5 --duration-sec 300 --headline-prefix "SYNTH"

Requires WEBHOOK_SHARED_SECRET_PRNEWSWIRE (or other provider secret) set in the environment to sign requests.

- RSS-file mode:

node ./tools/synth-publisher/cli.js --mode rss-file --file ./tools/synth-publisher/sample.xml --rps 0.5 --duration-sec 300

Serves an ephemeral feed at http://127.0.0.1:8899/feed.xml and mutates items.

Flags:
- --publish-offset-ms (default 0) can be negative/positive to simulate skew in published_at
- --tickers (comma-separated, default AAPL)

Outputs NDJSON under backend/artifacts/synth_pub_<ts>.ndjson
