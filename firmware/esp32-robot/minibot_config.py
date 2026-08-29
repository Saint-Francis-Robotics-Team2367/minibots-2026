"""Configuration builder for Minibot instances."""


class MinibotConfig:
    """Builder for Minibot configuration."""

    robot_id: str
    left_motor_pin: int
    right_motor_pin: int
    channel: int
    neutral_left_us: int | None
    neutral_right_us: int | None

    def __init__(self, robot_id: str, *, left_motor_pin: int, right_motor_pin: int, channel: int) -> None:
        """Initialize with required parameters.

        Args:
            robot_id: Unique identifier for the robot (truncated to MC_ROBOT_ID_MAX)
            left_motor_pin: GPIO pin for left motor
            right_motor_pin: GPIO pin for right motor
            channel: ESP-NOW channel
        """
        self.robot_id = robot_id
        self.left_motor_pin = left_motor_pin
        self.right_motor_pin = right_motor_pin
        self.channel = channel
        self.neutral_left_us = None
        self.neutral_right_us = None

    def with_neutral_left_us(self, us: int) -> "MinibotConfig":
        """Set neutral pulse width for left motor in microseconds.

        Defaults to 1500 us (RC standard). Range: 1000-2000 us.
        """
        self.neutral_left_us = us
        return self

    def with_neutral_right_us(self, us: int) -> "MinibotConfig":
        """Set neutral pulse width for right motor in microseconds.

        Defaults to 1500 us (RC standard). Range: 1000-2000 us.
        """
        self.neutral_right_us = us
        return self
