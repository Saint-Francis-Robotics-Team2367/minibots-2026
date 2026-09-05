"""OLED display driver for SSD1306."""

from machine import Pin, I2C
import framebuf
import ssd1306

# framebuf's built-in font is a fixed 8x8 glyph and cannot be resized, so
# large text is produced by blitting each source pixel as a filled rectangle.
_FONT_W = 8
_FONT_H = 8


class Display:
    """OLED display showing up to 3 lines of text, scaled to fill the panel."""

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

    # Longest string that still fits across the panel at 1x.
    def _max_chars(self) -> int:
        return self.WIDTH // _FONT_W

    def set_line1(self, text: str) -> None:
        """Set first line of text."""
        self.line1 = text[: self._max_chars()]

    def set_line2(self, text: str) -> None:
        """Set second line of text."""
        self.line2 = text[: self._max_chars()]

    def set_line3(self, text: str) -> None:
        """Set third line of text."""
        self.line3 = text[: self._max_chars()]

    def _draw_scaled(self, text: str, sx: int, sy: int, ox: int, oy: int) -> None:
        """Draw text magnified sx/sy times, with its top-left at (ox, oy)."""
        w = len(text) * _FONT_W
        # MONO_VLSB packs each column into ceil(h/8) bytes; h is 8, so w bytes.
        src = framebuf.FrameBuffer(bytearray(w), w, _FONT_H, framebuf.MONO_VLSB)
        src.fill(0)
        src.text(text, 0, 0, 1)
        for y in range(_FONT_H):
            for x in range(w):
                if src.pixel(x, y):
                    self.oled.fill_rect(ox + x * sx, oy + y * sy, sx, sy, 1)

    def show(self) -> None:
        """Update display, scaling the text as large as the panel allows."""
        self.oled.fill(0)

        lines = [t for t in (self.line1, self.line2, self.line3) if t]
        if lines:
            # Share the height evenly, so every row is the same size; each line
            # then gets the widest horizontal scale its own length permits.
            band = self.HEIGHT // len(lines)
            sy = max(1, band // _FONT_H)
            block_h = sy * _FONT_H * len(lines)
            oy = (self.HEIGHT - block_h) // 2
            for i, text in enumerate(lines):
                sx = max(1, self.WIDTH // (len(text) * _FONT_W))
                ox = (self.WIDTH - len(text) * _FONT_W * sx) // 2
                self._draw_scaled(text, sx, sy, ox, oy + i * sy * _FONT_H)

        self.oled.show()
