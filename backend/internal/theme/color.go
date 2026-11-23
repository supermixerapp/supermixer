package theme

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// RGB is a gamma-encoded sRGB colour with channels in [0, 1].
type RGB struct{ R, G, B float64 }

// OKLCH is a colour in the OKLCH space: lightness [0,1], chroma >= 0, hue in degrees.
type OKLCH struct{ L, C, H float64 }

// ParseHex parses #RGB or #RRGGBB.
func ParseHex(s string) (RGB, error) {
	h := strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 {
		return RGB{}, fmt.Errorf("invalid hex colour %q", s)
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return RGB{}, fmt.Errorf("invalid hex colour %q", s)
	}
	return RGB{
		R: float64(v>>16&0xff) / 255,
		G: float64(v>>8&0xff) / 255,
		B: float64(v&0xff) / 255,
	}, nil
}

// Hex formats the colour as lowercase #rrggbb, clamping out-of-range channels.
func (c RGB) Hex() string {
	to8 := func(x float64) int { return int(math.Round(clamp01(x) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", to8(c.R), to8(c.G), to8(c.B))
}

// HSL builds an sRGB colour from hue (deg), saturation and lightness (0-100).
func HSL(h, s, l float64) RGB {
	s, l = s/100, l/100
	c := (1 - math.Abs(2*l-1)) * s
	hp := math.Mod(h, 360) / 60
	x := c * (1 - math.Abs(math.Mod(hp, 2)-1))
	var r, g, b float64
	switch {
	case hp < 1:
		r, g, b = c, x, 0
	case hp < 2:
		r, g, b = x, c, 0
	case hp < 3:
		r, g, b = 0, c, x
	case hp < 4:
		r, g, b = 0, x, c
	case hp < 5:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	m := l - c/2
	return RGB{r + m, g + m, b + m}
}

func toLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func fromLinear(c float64) float64 {
	if c <= 0.0031308 {
		return 12.92 * c
	}
	return 1.055*math.Pow(c, 1/2.4) - 0.055
}

// ToOKLCH converts sRGB to OKLCH (Björn Ottosson's OKLab matrices).
func (c RGB) ToOKLCH() OKLCH {
	r, g, b := toLinear(c.R), toLinear(c.G), toLinear(c.B)
	l := math.Cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b)
	m := math.Cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b)
	s := math.Cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b)

	L := 0.2104542553*l + 0.7936177850*m - 0.0040720468*s
	A := 1.9779984951*l - 2.4285922050*m + 0.4505937099*s
	B := 0.0259040371*l + 0.7827717662*m - 0.8086757660*s

	C := math.Hypot(A, B)
	H := math.Atan2(B, A) * 180 / math.Pi
	if H < 0 {
		H += 360
	}
	return OKLCH{L, C, H}
}

// toRGBUnclamped converts OKLCH to sRGB without gamut mapping.
func (o OKLCH) toRGBUnclamped() RGB {
	hr := o.H * math.Pi / 180
	A, B := o.C*math.Cos(hr), o.C*math.Sin(hr)

	l := o.L + 0.3963377774*A + 0.2158037573*B
	m := o.L - 0.1055613458*A - 0.0638541728*B
	s := o.L - 0.0894841775*A - 1.2914855480*B
	l, m, s = l*l*l, m*m*m, s*s*s

	return RGB{
		R: fromLinear(+4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
		G: fromLinear(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
		B: fromLinear(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s),
	}
}

func (o OKLCH) inGamut() bool {
	c := o.toRGBUnclamped()
	const eps = 1e-6
	return c.R >= -eps && c.R <= 1+eps && c.G >= -eps && c.G <= 1+eps && c.B >= -eps && c.B <= 1+eps
}

// ToRGB converts to sRGB, reducing chroma (keeping lightness and hue) until the
// colour fits the sRGB gamut. This avoids the hue shifts of naive clipping.
func (o OKLCH) ToRGB() RGB {
	if o.inGamut() {
		return o.toRGBUnclamped()
	}
	lo, hi := 0.0, o.C
	for range 30 {
		mid := (lo + hi) / 2
		if (OKLCH{o.L, mid, o.H}).inGamut() {
			lo = mid
		} else {
			hi = mid
		}
	}
	return OKLCH{o.L, lo, o.H}.toRGBUnclamped()
}

// RelativeLuminance per WCAG 2.x.
func (c RGB) RelativeLuminance() float64 {
	c2 := RGB{clamp01(c.R), clamp01(c.G), clamp01(c.B)}
	return 0.2126*toLinear(c2.R) + 0.7152*toLinear(c2.G) + 0.0722*toLinear(c2.B)
}

// Contrast returns the WCAG contrast ratio between two colours (1 to 21).
func Contrast(a, b RGB) float64 {
	la, lb := a.RelativeLuminance(), b.RelativeLuminance()
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func clamp01(x float64) float64 { return math.Max(0, math.Min(1, x)) }
