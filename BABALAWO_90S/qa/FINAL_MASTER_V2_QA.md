# BABALAWO Prayer Room Master V2 QA

Status: PASS AS PRODUCTION PROOF / MASTER BASELINE

The approved Kling source clips contain a visible KlingAI watermark, so this file is not classified as a final public release asset.

## Final Master

- File: `BABALAWO_90S/final/BABALAWO_PRAYER_ROOM_90S_MASTER_V2.mp4`
- Runtime: 76.266667 seconds
- Hard ceiling: 90.000000 seconds
- Result: PASS; 13.733333 seconds below ceiling
- File size: 19,298,362 bytes
- SHA-256: `C132CA0A7F4C3B547FC17175586F241D50146E7E161AE0FB4D974337C071C2C3`

## Codec / Format

- Container: MP4 / QuickTime family
- Video codec: H.264
- Audio codec: AAC
- Resolution: 1280 x 720
- Aspect ratio: 16:9
- Frame rate: 30 fps
- Pixel format: yuv420p
- Audio sample rate: 48000 Hz
- Audio channels: stereo

## Loudness

- Final integrated loudness: -18.00 LUFS
- Final true peak: -1.52 dBTP
- Final loudness range: 3.90 LU
- Peak result: PASS; protected below clipping
- Processing note: original MP3 speech was not time-stretched, pitch-shifted, or speech-trimmed. Loudness processing applied gain normalization only.

## Section Timeline

| Section | Visual start | Visual end | Visual duration | Source audio | Source speech duration | Final audible speech span |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Opening settle | 0.000000 | 1.000000 | 1.000000 | silence | 0.000000 | 0.000000-1.000000 |
| 01 Opening | 1.000000 | 8.200000 | 7.200000 | `BABALAWO_01_OPENING.mp3` | 7.000813 | 1.000000-8.000813 |
| 02 Invocation | 8.200000 | 17.000000 | 8.800000 | `BABALAWO_02_INVOCATION.mp3` | 8.672625 | 8.200000-16.872625 |
| 03 Chant | 17.000000 | 29.600000 | 12.600000 | `BABALAWO_03_CHANT.mp3` | 12.591000 | 17.000000-29.591000 |
| 04 Main Prayer | 29.600000 | 54.400000 | 24.800000 | `BABALAWO_04_MAIN_PRAYER.mp3` | 24.685688 | 29.600000-54.285688 |
| 05 Blessing | 54.400000 | 64.000000 | 9.600000 | `BABALAWO_05_BLESSING.mp3` | 9.482438 | 54.400000-63.882438 |
| 06 Closing | 64.000000 | 76.266667 | 12.266667 | `BABALAWO_06_CLOSING.mp3` | 10.684063 | 64.000000-74.684063 |

Total authoritative source speech duration: 73.116627 seconds.

## Source Clip Mapping

| Section | Approved visual clip | Clip duration |
| --- | --- | ---: |
| 01 Opening | `BABALAWO_90S/kling/BABALAWO_KLING_01_OPENING.mov` | 7.200000 |
| 02 Invocation | `BABALAWO_90S/kling/BABALAWO_KLING_02_INVOCATION.mov` | 8.800000 |
| 03 Chant | `BABALAWO_90S/kling/BABALAWO_KLING_03_CHANT.mov` | 12.533333 |
| 04 Main Prayer | `BABALAWO_90S/kling/BABALAWO_KLING_04_MAIN_PRAYER.mov` | 24.800000 |
| 05 Blessing | `BABALAWO_90S/kling/BABALAWO_KLING_05_BLESSING.mov` | 9.600000 |
| 06 Closing | `BABALAWO_90S/kling/BABALAWO_KLING_06_CLOSING.mov` | 12.266667 |

The Chant visual was extended by 0.066667 seconds using its final frame so the complete 12.591000-second source audio can finish without clipping.

## Audio Authority

- Kling clip audio was not mapped into the final master.
- Final master contains one AAC audio stream.
- Final soundtrack was assembled from the six original MP3 files in the required order.
- No duplicate voice track, echo, or phasing was introduced by the assembly.
- No approved spoken audio was trimmed.

## Visual QA

- Opening settle reduced to approximately 1 second.
- No 4-second open-mouth frozen reflection is present.
- Frame hashes sampled from 55.97s-59.97s are distinct.
- Freeze detection found only the intentional opening settle at 0.000000-1.066667 seconds.
- No reflection beat was inserted between Main Prayer and Blessing.
- Clean cuts were used; no dissolves were added, avoiding ghost faces, ghost hands, or duplicate beads.
- Contact-sheet review shows Babalawo identity, shrine, tray, beads, bag, vessels, staff, room, doorway, and lighting remain consistent with the approved source clips.
- Hands and beads remain visually credible within the accepted source-clip behavior.
- The tray remains stable in the reviewed frames.
- No aggressive crop, digital zoom, artificial light effect, smoke, particles, subtitles, or AI enhancement was added.

## Remaining Visual Concerns

- Visible KlingAI watermark remains in the lower-right corner throughout the source clips and final master.
- Minor pose resets at section boundaries remain inherent to the separate approved Kling generations; bad dissolves were avoided.

## QA Artifacts

- Final contact sheet: `BABALAWO_90S/qa/frames/final_v2_contact_5s.png`
- Former reflection-window check: `BABALAWO_90S/qa/frames/final_v2_old_reflection_window.png`
- Render filter: `BABALAWO_90S/final/assemble_v2_filter.ffmpeg`
