"""Configuration builder for Minibot instances."""

from dataclasses import dataclass, field


@dataclass
class MinibotConfig:
    """Builder for Minibot configuration."""

    robot_id: str
    left_motor_pin: int
    right_motor_pin: int
    channel: int
    neutral_left_us: int = 1500
    neutral_right_us: int = 1500

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
