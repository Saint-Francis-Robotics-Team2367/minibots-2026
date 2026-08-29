/**
 * MiniCore *policy* constants — behaviour, not wire layout.
 *
 * SPLIT FROM minicore_protocol.h ON PURPOSE. That header is compiled into the
 * ESP32-S3 dongle, so editing it means a rebuild plus a physical BOOT/RESET
 * reflash. Everything in *this* file is enforced by the robot and mirrored by
 * the web driver station; the dongle neither uses nor includes it.
 *
 * The practical rule this buys you:
 *
 *   changed minicore_protocol.h  ->  flash-dongle AND flash-robot AND reload web
 *   changed minicore_policy.h    ->  flash-robot AND reload web  (dongle untouched)
 *
 * That distinction is not academic. Widening MC_NEUTRAL_TRIM_* used to force a
 * dongle reflash purely because minicore_bridge.c clamped there too — a policy
 * decision living in the transport. The clamp is gone; keep it that way, and
 * keep new policy constants in this file.
 *
 * Nothing in C includes this yet (the robot is MicroPython, the web is JS). It
 * is a valid header so a future C robot port can use it directly, and it is the
 * canonical source these two must stay in sync with:
 *   - firmware/esp32-robot/minibot.py
 *   - web/js/constants.js
 */
#ifndef MINICORE_POLICY_H
#define MINICORE_POLICY_H

#ifdef __cplusplus
extern "C" {
#endif

/* Robot stops the motors if no joystick frame arrives within this window. */
#define MC_MOTOR_TIMEOUT_MS 250u

/* How often the robot reports in. The station marks a robot stale at 2500 ms,
 * so this must stay comfortably under half that. */
#define MC_HEARTBEAT_INTERVAL_MS 1000u

/* Clamp for a neutral pulse arriving over the air (MC_MSG_SET_NEUTRAL).
 *
 * Enforced by the ROBOT, which is authoritative — it is the only tier that sees
 * every path in, including a calib.json hand-edited over the REPL, which never
 * touches the browser. Mirrored by the WEB inputs so the driver is told before
 * sending rather than after. The dongle does not clamp.
 *
 * This is the full 1-2 ms RC window, so the station can express any neutral the
 * ESC spec allows. It replaced a +/-100 us window around 1500: typical trim is
 * +/-30-50 us, but robots in this fleet run ESCs offset far enough (1700 us) to
 * be refused by the narrow range.
 *
 * Note what the wider range admits. Neutral is the pulse driven on every stop,
 * INCLUDING the 250 ms link-loss failsafe, so a neutral at either rail makes
 * "motors stopped" mean full throttle that way. What stands between a typo and
 * that: the robot's own pulse clamp, this only moving on an explicit Apply, and
 * the ack echoing back what actually landed. */
#define MC_NEUTRAL_TRIM_MIN_US 1000u
#define MC_NEUTRAL_TRIM_MAX_US 2000u

#ifdef __cplusplus
}
#endif

#endif /* MINICORE_POLICY_H */
