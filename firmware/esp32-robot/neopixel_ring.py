import neopixel
import machine


class NeoPixelRing:
    def __init__(self, num_leds: int = 12, pin: int = 14, *, max_intensity: int = 255):
        """
        Initialize a NeoPixel ring.

        Args:
            num_leds: Number of LEDs in the ring (default: 12)
            pin: GPIO pin number (default: 14)
            max_intensity: Maximum LED intensity 0-255 (default: 255)
        """
        self.num_leds = num_leds
        self.pin = machine.Pin(pin, machine.Pin.OUT)
        self.strip = neopixel.NeoPixel(self.pin, num_leds, bpp=3, timing=1)
        self.max_intensity = max_intensity

    def set_color(self, index: int, r: int, g: int, b: int) -> None:
        """Set the color of a single LED, scaled to max_intensity."""
        if 0 <= index < self.num_leds:
            scale = self.max_intensity / 255.0
            scaled_r = int(r * scale)
            scaled_g = int(g * scale)
            scaled_b = int(b * scale)
            self.strip[index] = (scaled_r, scaled_g, scaled_b)

    def set_all(self, r: int, g: int, b: int) -> None:
        """Set all LEDs to the same color."""
        for i in range(self.num_leds):
            self.set_color(i, r, g, b)

    def clear(self) -> None:
        """Turn off all LEDs."""
        self.set_all(0, 0, 0)

    def write(self) -> None:
        """Update the LED strip to show changes."""
        self.strip.write()

    def set_gradient(self, r_step: int, g_step: int, b_step: int) -> None:
        """Set a gradient across the ring."""
        for i in range(self.num_leds):
            self.set_color(i, r_step * i, g_step * i, b_step * i)

    def set_colors(self, colors: list) -> None:
        """Set colors across the ring, cycling through the color array as needed.

        Args:
            colors: List of (r, g, b) tuples. If shorter than num_leds, the pattern repeats.
        """
        if not colors:
            return
        for i in range(self.num_leds):
            r, g, b = colors[i % len(colors)]
            self.set_color(i, r, g, b)
