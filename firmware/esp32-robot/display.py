"""OLED display driver for SSD1306."""

from machine import Pin, I2C
import ssd1306


class Display:
    """OLED display showing 3 lines of text."""

    WIDTH: int
    HEIGHT: int
    line1: str
    line2: str
    line3: str

    def __init__(
        self,
        scl_pin: int = 22,
        sda_pin: int = 21,
        width: int = 128,
        height: int = 32,
        i2c_addr: int = 0x3C,
    ) -> None:
        """Initialize OLED display.

        Args:
            scl_pin: GPIO pin for I2C clock (default: 22)
            sda_pin: GPIO pin for I2C data (default: 21)
            width: Display width in pixels (default: 128)
            height: Display height in pixels (default: 32)
            i2c_addr: I2C address of display (default: 0x3C)
        """
        self.WIDTH = width
        self.HEIGHT = height

        i2c = I2C(0, scl=Pin(scl_pin), sda=Pin(sda_pin), freq=400000)
        self.oled = ssd1306.SSD1306_I2C(width, height, i2c, addr=i2c_addr)

        self.line1 = ""
        self.line2 = ""
        self.line3 = ""

        self.show()

    def set_line1(self, text: str) -> None:
        """Set first line of text."""
        self.line1 = text[:21]  # Truncate to fit display

    def set_line2(self, text: str) -> None:
        """Set second line of text."""
        self.line2 = text[:21]

    def set_line3(self, text: str) -> None:
        """Set third line of text."""
        self.line3 = text[:21]

    def show(self) -> None:
        """Update display with current text."""
        self.oled.fill(0)
        self.oled.text(self.line1, 0, 0)
        self.oled.text(self.line2, 0, 12)
        self.oled.text(self.line3, 0, 24)
        self.oled.show()
