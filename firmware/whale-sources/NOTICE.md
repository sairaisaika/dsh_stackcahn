# Whale face source images

The files in this folder are unmodified copies from the community asset pack
[AATINF/deepseek-whale-girl-assets](https://github.com/AATINF/deepseek-whale-girl-assets)
(`share-1600/`), retrieved 2026-11-21. The pack states that it is AI-generated
(wan2.7-image, image-to-image) from the reference sheets of
[TreapGoGo/deepseek-whale-girl](https://github.com/TreapGoGo/deepseek-whale-girl).

> 角色参考：TreapGoGo/deepseek-whale-girl（MIT License，Copyright (c) 2026 TreapGoGo）

鲸鱼娘 is a decentralised community character. It is not an official DeepSeek
character and these files do not represent DeepSeek.

| File | Pack title | Used for |
|---|---|---|
| C12.jpg | Q版·表情微笑 | neutral smile (woken, in conversation); base of the resting stare; closed mouth for speech on the happy face |
| C04.jpg | Q版·正面全身 | open mouth for speech |
| C19.jpg | Q版·表情眨眼 | closed eye for blinking (mirrored for the other eye) |
| C10.jpg | Q版·表情大笑 | happy |
| C15.jpg | Q版·表情不满 | angry |
| C84.jpg | Q版·表情吃醋 | sad (the pack has no plain sad face; this is its closest drawing) |
| C52.jpg | Q版·贴纸疑惑歪头 | doubt; also shown while waiting for a reply; its small flat mouth makes the resting stare |
| C78.jpg | Q版·表情困倦 | sleepy / offline |
| C17.jpg | Q版·表情惊讶 | surprised (Poke) |
| C82.jpg | Q版·表情得意 | head pat, under a script-drawn hand and hearts |
| P2.jpg | Q版·害羞脸红胸像 | shy, for a moment after a head pat |

`scripts/build_whale_avatar.mjs` crops, scales and aligns these by eye position.
Mouth and closed-eye patches are cut from the listed drawings and blended in; half-open mouth and half-closed eye frames are mixed by the script from those patches.
The patting hand and hearts are drawn by the script; the pack has no head-pat
drawing. The blob regenerated on 2026-11-21 carries layout version 2.

## Rights status — 2026-11-21

Checked against the user-specified gallery
[Iphsiibl/deepseek-whale-girl-gallery](https://github.com/Iphsiibl/deepseek-whale-girl-gallery)
(`README.md`, `ATTRIBUTION.md`, `LICENSE`):

- The character as a whole derives from 上善无形「溟月」→ ZipZipPipe「女仆装鲸鱼娘」
  and is stated there to be **CC BY-NC-SA 4.0**: attribution, no commercial use,
  derivatives shared alike.
- The gallery lists this pack (AATINF, TreapGoGo issue #37) with its source link
  and no separate licence. The pack's own README asks for the TreapGoGo credit
  above and describes the images as material for cutting out and reuse. Its
  repository has no `LICENSE` file (HTTP 404 on 2026-11-21).
- The gallery states that every image remains its author's, under the terms of
  its source, and that inclusion does not make an image MIT material.

Consequence for this project: these files are used for one private,
non-commercial device, with the credits above kept. **Do not publish this
folder, the generated blob, a firmware image containing it or the preview sheet**
without first confirming terms with the pack author; a public release should
either obtain that confirmation or replace the artwork.
