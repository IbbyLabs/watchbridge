# Changelog

## [0.9.3](https://github.com/IbbyLabs/watchbridge/compare/v0.9.2...v0.9.3) (2026-08-15)


### Performance Improvements

* **trakt:** skip the history pull when the cursor has not moved ([0e1aa40](https://github.com/IbbyLabs/watchbridge/commit/0e1aa40f98039bd6725ae3edfb43f055629deb19))

## [0.9.2](https://github.com/IbbyLabs/watchbridge/compare/v0.9.1...v0.9.2) (2026-08-15)


### Bug Fixes

* **repair:** say why there is nothing to check when no syncs exist ([01a811b](https://github.com/IbbyLabs/watchbridge/commit/01a811b861319d5088850c5a84e657fe05c10795))

## [0.9.1](https://github.com/IbbyLabs/watchbridge/compare/v0.9.0...v0.9.1) (2026-08-15)


### Bug Fixes

* **server:** register the repair routes so the page can reach them ([d41bbd7](https://github.com/IbbyLabs/watchbridge/commit/d41bbd76ac9ef22d294f78500fefa6aade2ab68a))

## [0.9.0](https://github.com/IbbyLabs/watchbridge/compare/v0.8.0...v0.9.0) (2026-08-15)


### Features

* **sync:** add history removal to the provider port (BUG-251) ([7296e44](https://github.com/IbbyLabs/watchbridge/commit/7296e447fda73365c89931788ad13e0b16f07d04))
* **sync:** repair history we delivered with the wrong date (BUG-251) ([072d70f](https://github.com/IbbyLabs/watchbridge/commit/072d70fb6c8884c6f5f588d64151d8a7730e4a07))
* **web:** let a person run the watch-date repair themselves (BUG-251) ([789ac8e](https://github.com/IbbyLabs/watchbridge/commit/789ac8e8c504b986c53ee3aed8a5da15bcb67755))


### Bug Fixes

* **mdblist:** keep every id a history row carries (BUG-251) ([3b8951e](https://github.com/IbbyLabs/watchbridge/commit/3b8951eb67ace156377ac11a8cf856e500ac66fe))
* **mdblist:** keep the watch date each history row carries (BUG-251) ([3282ae1](https://github.com/IbbyLabs/watchbridge/commit/3282ae17d8b3cc2b3bbd40f8fda1f1d79af71cfa))
* **mdblist:** write history with its dates, not scrobbles (BUG-251) ([ff85d03](https://github.com/IbbyLabs/watchbridge/commit/ff85d030e50db835598a52ace7b8247ef8d2badb))
* **simkl:** keep each episode's watch date on import (BUG-251) ([698c521](https://github.com/IbbyLabs/watchbridge/commit/698c521027431723d50d0249537633546fbee4af))
* **sync:** bound a repair chunk by elapsed time as well as count ([c458635](https://github.com/IbbyLabs/watchbridge/commit/c458635e1d2b054f870594518143fb6438117359))
* **sync:** correct dates in bounded chunks so a large repair can finish ([d832aa4](https://github.com/IbbyLabs/watchbridge/commit/d832aa4322b710badfce94a597027b8c03051ea5))
* **sync:** restore removed items even when the ledger is gone ([e1318be](https://github.com/IbbyLabs/watchbridge/commit/e1318be9f913bf5a6b04185a61a1a8023d095ad0))
* **sync:** stop a sync deletion destroying a pending repair intent ([713ded9](https://github.com/IbbyLabs/watchbridge/commit/713ded9940f66726c31da588f32fefbec6e4a1ec))
* **sync:** tell a person when an earlier attempt left an item removed ([019a901](https://github.com/IbbyLabs/watchbridge/commit/019a901811108140234fbd97af886bc7b10d7ed4))


### Performance Improvements

* **sync:** verify repairs in groups instead of re-reading per item ([bad2bb3](https://github.com/IbbyLabs/watchbridge/commit/bad2bb325d92d0389b43263fe756dfb3cc5f4dbe))

## [0.8.0](https://github.com/IbbyLabs/watchbridge/compare/v0.7.0...v0.8.0) (2026-07-25)


### Features

* **core:** ratings domain model and conflict planner ([db4505f](https://github.com/IbbyLabs/watchbridge/commit/db4505f90d65ad4df45e8437a358ffca7ac408dd))
* **core:** watchlist domain model and set-membership planner ([00e697f](https://github.com/IbbyLabs/watchbridge/commit/00e697f0057dcb5267a7801048bcd73d35cd4acc))
* download everything the account holds as one JSON file ([b3675e7](https://github.com/IbbyLabs/watchbridge/commit/b3675e7ee5743c177c27b87ff683ad64ecd6762d))
* email the owner when a scheduled sync starts failing or recovers ([1f34dfa](https://github.com/IbbyLabs/watchbridge/commit/1f34dfaec0e5c4b6508099ce5cf381352c350a89))
* flag a connection for reconnection when its credentials are rejected ([4d3ae65](https://github.com/IbbyLabs/watchbridge/commit/4d3ae65aa481803bec86479976a65ea2e7370bf3))
* flag a scheduled sync that has stopped running on time ([77ff11c](https://github.com/IbbyLabs/watchbridge/commit/77ff11cf5cb2bde1a44b65e62bda6976adf21b44))
* **providers:** ratings read and write for Trakt and Simkl ([f600495](https://github.com/IbbyLabs/watchbridge/commit/f600495ef73d1913d8b544fa5fd4690b1efecdfa))
* **server:** wire ratings syncs through the API ([05f5cee](https://github.com/IbbyLabs/watchbridge/commit/05f5ceeb7ea6b8230e68346de224015136f24e1f))
* show which items a run could not place ([e521f5c](https://github.com/IbbyLabs/watchbridge/commit/e521f5c15b7a4bb5a5022f45c471c2bb7b7d86db))
* **sync:** per-sync scope filters (media type, specials, exclusions) ([3773804](https://github.com/IbbyLabs/watchbridge/commit/3773804288a698a63a61e4f7148bce482421d3af))
* **sync:** record which correctness guards were in effect on each run ([eb3eb41](https://github.com/IbbyLabs/watchbridge/commit/eb3eb41903fb6effe22bb3a569a6a8f22f5b70d6))
* **sync:** show when a source skipped its pull because nothing changed ([f03a3e3](https://github.com/IbbyLabs/watchbridge/commit/f03a3e34e7163abda969a134ebf25fe3c10d6e98))
* **sync:** weekly full reconciliation to heal a stuck delta cursor ([b9a2dce](https://github.com/IbbyLabs/watchbridge/commit/b9a2dce99b6333801ed94c4ba9ccf1e8218267a4))
* watchlist sync between Trakt and Simkl ([5936ced](https://github.com/IbbyLabs/watchbridge/commit/5936ced11e3f8364afc80043bbafef5bafd1f7d2))
* **web:** ratings sync controls ([3a80411](https://github.com/IbbyLabs/watchbridge/commit/3a8041146c9da979a0a3e8fb114ea2613fcafb4d))
* **web:** show each sync's last run outcome on its card ([8a82a34](https://github.com/IbbyLabs/watchbridge/commit/8a82a345ba3caa307d6979affcd4c5d9f20f6084))


### Bug Fixes

* **auth:** rate-limit the remaining credential-guessing routes ([3935a84](https://github.com/IbbyLabs/watchbridge/commit/3935a84375daac1da8b2dbf6640319470c89a501))
* **connections:** forget a provider's cursors and delivery memory when its account changes ([3eb231a](https://github.com/IbbyLabs/watchbridge/commit/3eb231a5d81d8007ef907c75673cc0e2ec072964))
* **db:** scrub any credential left in an old sync error row ([0108790](https://github.com/IbbyLabs/watchbridge/commit/01087907016f703a537d23898b4087a128730cda))
* **http:** pace writes separately from reads and floor retry backoff ([437d46b](https://github.com/IbbyLabs/watchbridge/commit/437d46b07be2d124cdee43f16fc675afe016b599))
* keep credentials out of stored errors and explain provider failures in words ([70b003e](https://github.com/IbbyLabs/watchbridge/commit/70b003e20db16da161f537a21f0713aa02da165c))
* pace all provider traffic against one shared limit per upstream ([2c5abe9](https://github.com/IbbyLabs/watchbridge/commit/2c5abe9e106232415801291c7a375a3ec945e005))
* **pmdb:** don't send a resume position that would be recorded as a finished play ([87dc670](https://github.com/IbbyLabs/watchbridge/commit/87dc670f6581a1311c2b92223f0bdb3886a0f947))
* **providers:** report why a write failed instead of only how many ([a9ebc42](https://github.com/IbbyLabs/watchbridge/commit/a9ebc4221a9498d508d15c8485a858364f617f4d))
* **simkl:** stop recording rejected history items as delivered ([501af91](https://github.com/IbbyLabs/watchbridge/commit/501af910e597665ff2c13baa43fca091b12302b6))
* **sync:** a failing data type no longer discards the rest of the run ([6b1f0d7](https://github.com/IbbyLabs/watchbridge/commit/6b1f0d7b00df32745b6855dfc44c5294f3e18167))
* **sync:** let the newer resume position win a progress conflict ([903de87](https://github.com/IbbyLabs/watchbridge/commit/903de8725726845f1a002c0787dc56feb43466fd))
* **sync:** stop episodes without a season or number colliding ([36df6ca](https://github.com/IbbyLabs/watchbridge/commit/36df6ca9d112ab50ee5b16ae266e877703cee714))
* **sync:** stop reading a failed provider call as an empty library ([41c10d8](https://github.com/IbbyLabs/watchbridge/commit/41c10d8469d1d12fc42c84a31e87fe8454750789))
* **trakt:** page the playback pull and bound paging ([26ce96e](https://github.com/IbbyLabs/watchbridge/commit/26ce96ec33cff153f3e3765047c09e0461d4c156))
* **watchlist:** stop re-adding a title the target auto-removes on watch ([fc35d0f](https://github.com/IbbyLabs/watchbridge/commit/fc35d0f8caa9a436843375ef569fb075dcd97256))
* **web:** finish the accessibility pass on focus, fields, dialogs and titles ([357e109](https://github.com/IbbyLabs/watchbridge/commit/357e10921a87cc5d43e75b3636d0b3beaf20d993))
* **web:** meet WCAG AA on text contrast, status and live regions ([bafb023](https://github.com/IbbyLabs/watchbridge/commit/bafb02318b0b4cb8a70d736ad414d97350d6eaad))

## [0.7.0](https://github.com/IbbyLabs/watchbridge/compare/v0.6.1...v0.7.0) (2026-07-22)


### Features

* **server:** log sync run outcomes and verify the encryption key at startup ([ea3eccd](https://github.com/IbbyLabs/watchbridge/commit/ea3eccdb0cb837a7ccf2def2f927f33e1f4cd205))

## [0.6.1](https://github.com/IbbyLabs/watchbridge/compare/v0.6.0...v0.6.1) (2026-07-12)


### Bug Fixes

* **docker:** bake APP_VERSION after the app COPY so it isn't cached stale ([3921660](https://github.com/IbbyLabs/watchbridge/commit/392166040c3b367dad11d31c9a1ac303be1ceddc))

## [0.6.0](https://github.com/IbbyLabs/watchbridge/compare/v0.5.0...v0.6.0) (2026-07-12)


### Features

* **providers:** add MDBList as a sync provider ([9d42647](https://github.com/IbbyLabs/watchbridge/commit/9d4264780c05f105f6e380397c3aeee6c35b5f92))
