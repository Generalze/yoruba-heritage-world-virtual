# BABALAWO 90S Asset Verification Report

Status: local preparation complete; final V2 assembly rendered from supplied approved Kling clips. No new Kling generation was submitted.

## Source Image

- Selected file: `BABALAWO_90S/source/02_MEDIUM_PRAYER.png`
- Original source path: `C:\Users\zoeme\Downloads\ILE_AWON_BABALAWO_APPROVED_6_IMAGES\02_MEDIUM_PRAYER.png`
- Matching house-copy path: `C:\Users\zoeme\Downloads\YHW_MASTER_VISUAL_IMPLEMENTATION_V2_24_IMAGES\YHW_MASTER_VISUAL_IMPLEMENTATION_V2\01_ILE_AWON_BABALAWO\02_MEDIUM_PRAYER.png`
- Hash match: yes; both candidate images are byte-identical.
- Dimensions: 1672 x 941
- Pixel format: rgb24
- SHA-256: `43B57A7248448449515A5E268CF7BD7465ED420AC587F2DDF62861990AFCAE85`

## Source Audio

All staged files are MP3, 44100 Hz, mono. The final master must use these originals as the authoritative soundtrack.

| Order | File | Duration seconds | SHA-256 |
| --- | --- | ---: | --- |
| 1 | `BABALAWO_01_OPENING.mp3` | 7.000813 | `C5484EB9474E9570BBDC8BEE82C552DEF15C0FE1BFF9523C2716B93B7EED1A2F` |
| 2 | `BABALAWO_02_INVOCATION.mp3` | 8.672625 | `51CB6DC7462779D31481209BFF14C847D3D6E2EF9DA871D888D8BCB0ED7C6E3A` |
| 3 | `BABALAWO_03_CHANT.mp3` | 12.591000 | `E6B0ADBE368611908E32DE79E0C3BB31056BF4861905637AB8F7DE0AEFB2BC79` |
| 4 | `BABALAWO_04_MAIN_PRAYER.mp3` | 24.685688 | `4F08C22C54829AB075DA0B1D3BF6DDDC85B63368B39BB0C33F9606F2C9A29013` |
| 5 | `BABALAWO_05_BLESSING.mp3` | 9.482438 | `C0A6428B5422339E509103E9A63F1DB118387F9A92C11EECB57798A821919625` |
| 6 | `BABALAWO_06_CLOSING.mp3` | 10.684063 | `4F899BF4F7CAB9D2A67DBAD636986FD8B03F3FA6FDC31972D6DF45666F042DF2` |

## Runtime Budget

- Total source speech duration: 73.116627 seconds
- Hard cap: 90.000000 seconds
- Remaining time under cap: 16.883373 seconds
- Runtime gate result: PASS; the approved speech does not exceed 90 seconds.

Recommended non-speech budget, subject to actual generated clip durations:

- Opening settling: up to 3.000 seconds
- Reflection pause: up to 4.000 seconds
- Final settling: up to 5.000 seconds
- Planned maximum with these holds: 85.116627 seconds
- Slack below hard cap after planned holds: 4.883373 seconds

## Kling Authorization Check

- Node.js: v24.18.0
- npm: 11.17.0
- Kling CLI: kling-cli 0.2.0
- `who_am_i`: failed because no login state was present.
- Browser OAuth login was launched and waited for 300 seconds.
- Login result: timed out before browser authorization completed.
- Retry result: a later login retry also timed out after 300 seconds.
- Second retry diagnostics:
  - The local callback listener on `127.0.0.1:8787` was active while login was waiting.
  - `https://kling.ai/` returned HTTP 200 from the local machine.
  - The fresh OAuth URL resolved to `https://kling.ai/app/authorize?auth_request_id=authreq-f4ddf195173b4912b93bbd32514ad853`, but browser authorization still did not complete before timeout.
- Later retry result: login succeeded; tokens were saved by the Kling CLI.
- Authorized account check:
  - Membership: VIP / Standard
  - Available credits at check time: 660

## Live Kling Capability Check

The live schema exposes these relevant tools and controls:

- `image_to_video`
  - accepts a first image / reference image depending on model
  - supports durations up to 10 or 15 seconds depending on model
  - exposes `enable_audio` for model-generated/native audio
  - exposes no input slot for a supplied `.mp3` file as lip-sync audio
- `text_to_video`
  - exposes `enable_audio`, `audio_prompt`, or `music_prompt` on some models
  - exposes no supplied-audio input and does not preserve the approved reference image
- `motion_control`
  - accepts a subject image and a motion-source video or saved motion ID
  - can retain sound from the motion video with `keepOriginalSound`
  - does not accept standalone approved MP3 audio as an audio-driven talking-image input
- `element_create`
  - accepts optional `.mp3` voice for reusable Elements
  - this is not declared as exact speech-performance lip sync for the supplied prayer recordings

Capability gate result: BLOCKED. No paid Kling generation was submitted because the available local Kling CLI schema does not provide the required reference-image plus uploaded-authoritative-MP3 lip-sync/avatar workflow.

Generation must resume with a successful `kling login`, followed by `who_am_i`, `tool_list`, and `account` before any paid generation command.
