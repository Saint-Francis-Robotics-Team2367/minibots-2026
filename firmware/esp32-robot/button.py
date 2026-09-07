import machine


class Button:
    def __init__(self, pin: int = 13):
        """
        Initialize a button.

        Args:
            pin: GPIO pin number (default: 13)
        """
        self.pin = machine.Pin(pin, machine.Pin.IN, machine.Pin.PULL_UP)
        self._last_state = 1
        self._pressed = False

    def is_pressed(self) -> bool:
        """Check if the button is currently pressed (active low)."""
        return self.pin.value() == 0

    def check(self) -> bool:
        """Check for a button press event (detects transition from released to pressed).

        Returns True if the button was just pressed, False otherwise.
        """
        current_state = self.pin.value()
        if self._last_state == 1 and current_state == 0:
            self._pressed = True
        else:
            self._pressed = False
        self._last_state = current_state
        return self._pressed
