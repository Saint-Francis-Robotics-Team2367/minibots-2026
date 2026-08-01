# ============================================================================
#  main.py  —  THIS IS YOUR ROBOT CODE.  Edit this file!
# ============================================================================
#
#  This runs automatically every time your robot powers on.
#
#  The Minibot library (minibot.py) handles talking to the driver station for
#  you. Your job is to decide what the robot *does* with the controller input.
#
#  Quick reference — everything you can call on `bot`:
#
#    Setup (once):
#      bot.begin()
#
#    Every loop (call FIRST):
#      bot.update()
#
#    Read the joystick (all return -1.0 .. 1.0, 0.0 = centered):
#      bot.get_left_x()   bot.get_left_y()
#      bot.get_right_x()  bot.get_right_y()
#      bot.get_left_trigger()   bot.get_right_trigger()
#
#    Read buttons (True when held down):
#      bot.get_cross()   bot.get_circle()
#      bot.get_square()  bot.get_triangle()
#
#    Is the driver station letting us drive?
#      bot.get_game_status()  ->  Minibot.TELEOP  or  Minibot.STANDBY
#
#    Drive the motors (-1.0 = full reverse, 0.0 = stop, 1.0 = full forward):
#      bot.drive_left_motor(value)
#      bot.drive_right_motor(value)
#      bot.stop_all_motors()
#
#    The two drive_* calls RAMP toward the value you ask for instead of jumping
#    straight to it (a full forward-to-reverse reversal takes about half a
#    second), so slamming the sticks can't spike the motor current and brown out
#    the board. stop_all_motors() is always immediate.
# ============================================================================

from minibot import Minibot

# Create your robot. Put YOUR robot's name in the quotes so it shows up in the
# driver station. Change the pins if your motors are wired differently, and
# make sure `channel` matches the dongle (default 6).
#
# If your wheels creep or spin while the sticks are centered, your ESCs want a
# different neutral pulse. Add neutral_us= and adjust it until the robot sits
# still (1500 is the RC standard; try 20-30 us at a time):
#     bot = Minibot("MiniBot1", ..., neutral_us=1500)
bot = Minibot("MiniBot1", left_motor_pin=16, right_motor_pin=17, channel=6)

bot.begin()

while True:
    bot.update()  # ALWAYS FIRST — handles comms, enable and the safety stop.

    if bot.get_game_status() == Minibot.STANDBY:
        # Not enabled by the driver station — stay still.
        bot.stop_all_motors()
    else:
        # Tank drive: left stick drives the left tread, right stick the right.
        # Pushing a stick up gives a negative value, so we flip the sign.
        bot.drive_left_motor(-bot.get_left_y())
        bot.drive_right_motor(-bot.get_right_y())
