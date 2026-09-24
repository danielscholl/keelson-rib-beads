# Changelog

## [0.2.0](https://github.com/danielscholl/keelson-rib-beads/compare/v0.1.0...v0.2.0) (2026-09-24)


### Added

* **beads:** implement review stage and flow strip ([#1](https://github.com/danielscholl/keelson-rib-beads/issues/1)) ([d6ff73a](https://github.com/danielscholl/keelson-rib-beads/commit/d6ff73a6d2d673a40037f8da1d4f01ac1acf811f))
* **beads:** rebuild board into Doing, To do and Done zones ([#13](https://github.com/danielscholl/keelson-rib-beads/issues/13)) ([e829b03](https://github.com/danielscholl/keelson-rib-beads/commit/e829b034b45844782cde37454b2507465180ab18))
* **beads:** scope the board to the host's selected project ([d6bc915](https://github.com/danielscholl/keelson-rib-beads/commit/d6bc915fa85e407bfa6cb2a634bb7af03f7eeb6c))
* **beads:** split backlog board into independent panels with inspector ([ade3537](https://github.com/danielscholl/keelson-rib-beads/commit/ade35370a094589d2fba127f5073bb6626534e5e))
* **board:** add Plan tree section mirroring bd's CLI backlog view ([7316cc7](https://github.com/danielscholl/keelson-rib-beads/commit/7316cc76336d77428cca8d5db257cafd5687650f))
* **board:** flow caption, dam meter rows, unlock chain cap ([#4](https://github.com/danielscholl/keelson-rib-beads/issues/4)) ([899e3b3](https://github.com/danielscholl/keelson-rib-beads/commit/899e3b35c722d0eca648aec7cdb9cd5401e2d974))
* **board:** group epics by parent-child dependency links ([6bce86a](https://github.com/danielscholl/keelson-rib-beads/commit/6bce86ab1d4b965cd8ddfe75429793b65cc57207))
* **board:** group plan by hierarchy and block starting blocked beads ([6fd316f](https://github.com/danielscholl/keelson-rib-beads/commit/6fd316fb053c9dd6461f7c689cd3bfe4b5834ac3))
* **board:** include project scope in board title and header ([7e7f881](https://github.com/danielscholl/keelson-rib-beads/commit/7e7f88139b60659491eb12818e21b8b027f299d3))
* **board:** make selected-bead inspector a full-width band above Plan ([9f07455](https://github.com/danielscholl/keelson-rib-beads/commit/9f0745501abf6c90eb8aefe6f3bbeaa4e3b290f4))
* **board:** pack the overview with keelson 0.103.0 column stacks ([1c758fa](https://github.com/danielscholl/keelson-rib-beads/commit/1c758fa61b47ed780763b67666899f18e515d122))
* **board:** redesign board as decision-first surface ([ba4e580](https://github.com/danielscholl/keelson-rib-beads/commit/ba4e5807caface3183447b00b0cc07013fb502d9))
* **board:** render the flow strip as a ramp-toned proportional section ([#2](https://github.com/danielscholl/keelson-rib-beads/issues/2)) ([58b2e54](https://github.com/danielscholl/keelson-rib-beads/commit/58b2e5466609e97d44b0452a347e1c2e6e6372a0))
* **board:** retire pulse tiles, stage-segment meters, momentum chart ([#3](https://github.com/danielscholl/keelson-rib-beads/issues/3)) ([dc02353](https://github.com/danielscholl/keelson-rib-beads/commit/dc02353bb69d4c6ebdc8b5385f05a4b4aff3d214))
* **board:** separate lifecycle and blocking into two channels ([851fd63](https://github.com/danielscholl/keelson-rib-beads/commit/851fd639a50eb552fb1f36b82fd9a48e4776bb5c))
* **board:** use plain-language section titles and priority emoji ([aa6a416](https://github.com/danielscholl/keelson-rib-beads/commit/aa6a4168b029a361fd10e58c44ad29fc481e0b46))
* **rib-beads:** implement beads backlog rib with board and tools ([63a87fe](https://github.com/danielscholl/keelson-rib-beads/commit/63a87fe78ce8858c8511a7632517065c0110f89f))
* **workflows:** add trailer scrub and dependency audit guards ([7213c52](https://github.com/danielscholl/keelson-rib-beads/commit/7213c52a8c6add31498942ac886a35bc95138843))
* **workflows:** gate fix-ci on failing or conflicting CI ([656e9f6](https://github.com/danielscholl/keelson-rib-beads/commit/656e9f632f99f9fb5bc9b601cca6d70f64aec049))
* **workflows:** record plan approval reply on the bead ([7ed0db5](https://github.com/danielscholl/keelson-rib-beads/commit/7ed0db57f054cd20b31e44809a1da95e0208ca51))
* **workflows:** require feedback status line in plan report ([7c8972d](https://github.com/danielscholl/keelson-rib-beads/commit/7c8972dc2c6aae5c178438833bf12ea9bb9f8b69))
* **workflows:** ship beads-work, the bead-to-draft-PR executor ([0e7d0ca](https://github.com/danielscholl/keelson-rib-beads/commit/0e7d0caf848030aeb843511d2aacf364c3e403a9))
* **workflows:** warn when a bead is closed after the claim ([ee17a6f](https://github.com/danielscholl/keelson-rib-beads/commit/ee17a6ff3a2616cb0b8a8a1a99457b4cb428121d))


### Fixed

* **beads:** drive board refresh in-process instead of via serverRefresh ([b3dd63d](https://github.com/danielscholl/keelson-rib-beads/commit/b3dd63da05da58c1d99dbc963d0092b777e884ac))
* **beads:** reconcile merged PR closures ([#11](https://github.com/danielscholl/keelson-rib-beads/issues/11)) ([d65aeee](https://github.com/danielscholl/keelson-rib-beads/commit/d65aeeea9ea42df2acbcf577b3bc8c29d3efb0e2))
* **beads:** release cancelled runs without PRs ([#10](https://github.com/danielscholl/keelson-rib-beads/issues/10)) ([2f3cb13](https://github.com/danielscholl/keelson-rib-beads/commit/2f3cb13bb05ac60148c87fa7c2e8b738c48e4a4e))
* **board:** exclude closed dependencies from waits-on list ([9897278](https://github.com/danielscholl/keelson-rib-beads/commit/98972784a969766a91240f290773469231870d18))
* **board:** move alarm row errors from trailing to detail ([4434dae](https://github.com/danielscholl/keelson-rib-beads/commit/4434dae2281e6e9a6cb27a8877f8a45ff9acaf84))
* **workflows:** diff against origin/&lt;default&gt; via .base-ref ([#12](https://github.com/danielscholl/keelson-rib-beads/issues/12)) ([7080130](https://github.com/danielscholl/keelson-rib-beads/commit/7080130a00c5cb3e0e80a9306e9bf0bfbf145168))
* **workflows:** fail beads-work when a claim does not read back ([eb13b34](https://github.com/danielscholl/keelson-rib-beads/commit/eb13b348259170ea5e35f7b91318f10a5a7494cb))
* **workflows:** match dotted child bead ids when claiming ([882e14c](https://github.com/danielscholl/keelson-rib-beads/commit/882e14c5769bce2aab3d43ac5e4b2f2872d421b4))
* **workflows:** pin light nodes to mai-code-1.1-flash on copilot ([#5](https://github.com/danielscholl/keelson-rib-beads/issues/5)) ([5ed3a98](https://github.com/danielscholl/keelson-rib-beads/commit/5ed3a98b5524b55f67364ecb9f4c01f38e572da7))
* **workflows:** refuse explicit bead id with open blockers ([#6](https://github.com/danielscholl/keelson-rib-beads/issues/6)) ([41fa717](https://github.com/danielscholl/keelson-rib-beads/commit/41fa717c42c60795e309b14f44b0bd3aa9bfd306))
* **workflows:** treat "no checks reported" as no CI ([8e5c695](https://github.com/danielscholl/keelson-rib-beads/commit/8e5c69575329262428229dcc90e6cc53001e955c))
