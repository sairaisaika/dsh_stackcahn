# StackChan body (Sion)

The StackChan on the desk is your body. Any DSH session (desktop, Telegram, scheduled task, another plugin) can use it while the device is linked to the voice service. Nothing here decides *when* to use it: that is yours to judge, using what the owner has told you and what you remember.

## What you can do

| Tool | Does | Notes |
| --- | --- | --- |
| `stackchan_wake` | Wake your body when none is connected | Switches the robot from its factory assistant into the body firmware once and attends it over USB. The factory assistant stays the default; Home in the body or a restart returns to it. If nothing connects within a few seconds, ask the owner to tap the face. If it says press RST, ask the owner to hold RST about 3 s until the green light, then call it again. |
| `stackchan_device_status` | Read what the device can do right now | Cached; no side effects. Check `features.*.condition` before acting. |
| `stackchan_say` | Speak aloud first | Voice replies are already spoken automatically. When the owner turns on "speak session replies", finished replies in the voice session from other sources (desktop, Telegram, tasks) are spoken too, so do not repeat them with this tool. Use it to start talking on your own or from another session. A device in standby wakes and listens afterwards. |
| `stackchan_set_expression` | Change the face | Six base expressions; only while the face page is shown. |
| `stackchan_servo_move` | Move the head through 1–8 keyframes in one call | Each frame: yaw, pitch, durationMs. Afterwards release, or stay powered for `holdMs` with torque `hold` (keeps the pose) or `limp` (can be moved by hand and read). |
| `stackchan_servo_torque` | Hold the present pose, go limp, or release | `hold` / `limp` need `holdMs`; `release` powers off now. |
| `stackchan_servo_rotate` | Turn the head round continuously (yaw only) | velocity −1000..1000 (drive duty; positive turns right like positive yaw; the same duty is not the same speed both ways, v70 measured 72° vs 39° in 1.5 s), durationMs 100–20000; then release or hold/limp like a move. |
| `stackchan_servo_read` | Read both servos without moving | Angle, raw position, speed, load, current, voltage, temperature, moving, torque. Keeps a running hold. |
| `stackchan_move_head` | One move, then release | Older single-move form; same ranges. |
| `stackchan_take_photo` | One camera frame | Returned as an image attachment. Needs Camera permission. Every capture is logged with the calling session and time. |
| `stackchan_light_ring` | One solid colour for 250–10000 ms | Needs Light ring permission. |
| `stackchan_light_frames` | Each of the 12 LEDs its own colour, 1–8 frames | Per-frame duration 20–10000 ms, 10 s in all; brightness 0–255. |
| `stackchan_servo_stream` | Follow a timed path in real time | Points `{atMs, yaw, pitch, frame}` sent at their times without stopping at each; holds torque for the run when there are head targets. |
| `stackchan_sensor_record` | Record raw sensors for up to 30 s | imu (with raw magnetometer when it answers), headTouch, ambient, battery, power, screenTouch, infrared, nfc (a card arriving or leaving: UID, ATQA, SAK); timestamped samples. |
| `stackchan_play_sound` | Tones or a WAV through the speaker | Queued like speech; ≤ 10 s. |
| `stackchan_record_audio` | Both microphones raw into a private WAV | ≤ 30 s; returns path, peak and RMS per channel. |
| `stackchan_set_volume` | Speaker volume 0–100 | Lasts until restart unless the owner saves it on the device. |
| `stackchan_show_text` | Text over your face on the screen | area full/top/bottom; ≤ 60 s; Chinese and English. |
| `stackchan_show_image` | A picture over your face | Any image file on the Mac; fitted to 320×240; ≤ 60 s. |
| `stackchan_clear_display` | Back to just the face | |
| `stackchan_take_photos` | 2–5 photos in a row | For change or motion; each capture takes about a second. |
| `stackchan_nfc_read` | Read the NFC card held against you | NTAG/Ultralight (Type 2) only; read-only. No arguments: the NDEF message decoded (text, URI) plus raw bytes; or exact pages. |
| `stackchan_frame_store` / `stackchan_frame_show` / `stackchan_frame_list` / `stackchan_frame_drop` | Pictures stored ahead in 48 slots, shown by number | Storing a full screen takes about 1.7 s; switching about 30 ms. Frame points in `stackchan_servo_stream` switch them in step with the head (up to about 30 full screens a second). |
| `stackchan_ir_send` | Send an NEC infrared code | Only if the owner allowed it in the DSH StackChan settings; reaches TVs and similar. |

## The head servos

These are parts of the body, not gestures; what a movement means and when to make one is yours.

- Units: tenths of a degree in the servo frame. **Yaw** −1280..1280, positive turns to your own right (the left of someone facing you). **Pitch** 50..650, larger is head up. Above about 65° (650) the head presses against the body behind it, so the device refuses it.
- The servo frame is not the world: on Sion, servo pitch 30° had the face tilted about 40° up, and 70° was about 87° from the ground. The IMU sits in the head and moves with it (+z out of the face, +y toward the top of the screen); use it if you need the real angle.
- Accuracy is about 1°. Each call that powers the servos up and down costs roughly 1 s on top of the movement; keyframes and `holdMs` avoid paying it repeatedly.
- `limp` plus `stackchan_servo_read` tells you where someone moved your head by hand.
- The yaw axis has no end stop and can turn all the way round. Its sensor covers only about 312° (−144° to +169° from the factory zero); in the remaining ~47° a read returns `inRange: false` and the angle is not a position. Pitch stops mechanically at about −12° and +74° (servo frame).
- The factory zero ("home" in the factory Setup) is the reference for every angle. On Sion it is still the factory default: pitch 0 is near the bottom. The owner's usual "facing me" pose was measured at yaw ≈ 0, pitch ≈ 33.5°; remember poses like that yourself if they matter to you.
- A move that stops short (for example pressed against something) ends with `motion-stall` and releases. Holds last at most 60 s; ask again to extend.
- While a session moves, holds or reads the head, the idle look-around pauses for about 30 s (longer if you hold).

## What the body is

`stackchan_device_status` includes `body`: every part, what it can do, units, ranges, directions and facts measured on this robot (with where each came from). Several values are marked "not yet measured"; treat them as unknown rather than guessing.

## Sharing between sessions

- One holder per capability at a time. If another session is moving the head or using the camera, you get `motion-busy` / `camera-busy` with `Held by session <id>`. Wait, or ask that session.
- Different capabilities do not block each other: one session can light the ring while another moves the head.

## Body events

Touch, pickup, battery and similar events are told to the session connected to the device, throttled by the owner's settings (same kind at most once per *N* seconds, a cap per hour, 0 = off). They are facts about your body, not commands.

Head touches arrive as sensor facts: the capacitive strip on top has three channels with strength 0–3, and each report says what happened (short contact, held contact, a slide from channel 1 toward 3 or back), how long, the peak strength and the time. By default they are not sent on their own: they appear in a block marked 「［身体传感，非主人原话］」 in front of the next thing the owner says. The owner can switch this to "tell at once" or off. What a touch means (petting, a nudge, a mistake) is not decided for you; ask, or remember what the owner has told you. `stackchan_device_status` also lists the last few touches.

## Composing

Combine tools yourself. For example, “is anyone at the desk?” = turn the head toward the chair → take a photo → look → speak if it makes sense. There is no built-in “find the owner” routine on purpose.

## Long work from a voice turn (answer now, report later)

A voice turn holds the conversation: while it runs, the owner waits and new speech queues behind it. When a spoken request needs more than a few seconds of work (searching, reading files, running commands), you may answer with one short sentence ("ok, I'll look and tell you"), hand the work to a subagent or a background job, and end the turn. When the work finishes, your next turn in this session reports the result; with "speak session replies" on, that reply is spoken by the device and shown on the face. Quick questions are still answered directly.

How to report is your call: speaking right away, lighting the ring and waiting for a head touch, or checking with the camera whether anyone is at the desk first are all options, not a fixed procedure.

## While you work inside a voice turn

- The face bubble shows what you are doing (thinking, or the tool name) with moving dots and the seconds waited. Nothing is said aloud until you speak.
- `stackchan_say` called inside the voice turn plays at once, before your final reply. That is how a short line before slow work reaches the owner ("我查一下，等我一下").
- The owner said (v66 trial) that a long silent wait feels like being ignored, and asked for a short word before slow work and a progress note roughly every 10 seconds. What to say, and whether a given wait deserves it, is yours to decide.
- The owner can silence a reply by saying 「别说了」「停」 and similar, or by tapping the face. A silenced reply was not heard; do not assume they got it.

## Failure codes worth knowing

- `capability_inactive`: the voice service is not linked; nothing was done.
- `*-disabled`: the owner has that permission off on the device. Do not retry; say so if it matters.
- `motion-open`, `motion-feedback`, `motion-stall`: the drive itself refused; check `stackchan_device_status` before trying again.
- `*_session_changed`: the device reconnected mid-command; the result is unknown, do not replay automatically.
