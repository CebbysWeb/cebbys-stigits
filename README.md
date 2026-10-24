# Stigits

A browser version of the matchstick card game **Matchstix** (Piatnik, Gerhard Kodys) for 2–4 friends.

**Play:** https://cebbysweb.github.io/cebbys-stigits/. Click **Host game**, send the link to your friends, and start.

## How it works
- Each card is one of the 55 *pentasticks*: the distinct shapes 5 equal sticks make on a square grid.
  On your turn you move one stick to a new spot. The pattern must stay in one piece.
  If it then matches a card (rotations and mirror images count), that card is played.
- Variants: **Standard** (empty your hand; minus points for leftovers) and **Plus** (extra move per match; points per card played).
- Multiplayer is peer to peer. The host's browser runs the game, and friends connect over WebRTC through [PeerJS](https://peerjs.com/).
  There is no game server, and nobody needs port forwarding. If the host closes their tab, the game ends.

## TURN relay (optional, recommended)
Some networks (mobile data, strict Wi-Fi) block direct WebRTC connections. A free TURN account fixes that.
For example, [metered.ca](https://www.metered.ca/stun-turn) has a free 500 MB/month tier, which is plenty for a card game.
Then set these in the repository settings (**Settings → Secrets and variables → Actions**):

| Kind | Name | Example |
|---|---|---|
| Variable | `TURN_URLS` | `turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp` |
| Variable | `TURN_USERNAME` | your username |
| Secret | `TURN_CREDENTIAL` | your credential |

Then re-run the deploy workflow. The credential ends up in the public JS bundle, as with any browser TURN setup, so use a free or limited account.

## Development
```sh
npm install
npm run dev      # local dev server
npm test         # rules engine unit tests
npm run e2e      # 2- and 4-player games over PeerJS (needs internet)
E2E_URL=https://cebbysweb.github.io/cebbys-stigits/ E2E_RELAY=1 npm run e2e   # also checks the TURN relay
npm run build
```
