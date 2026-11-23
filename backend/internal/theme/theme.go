// Package theme derives Supermixer's brand colours from appearance.brand_color.
//
// Supabase Studio's colour system (packages/ui/build/css/source/semantic.css)
// is driven by a single --hue input plus a few fixed OKLCH anchors for the
// primary colour, and a stepped legacy "brand" scale (200–600) per theme. We
// keep that structure and swap the green for the configured brand:
//
//   - --hue becomes the brand's OKLCH hue, so neutrals and status colours pick
//     up the same subtle tint Studio gives them.
//   - Solid primary buttons use the exact brand colour in both themes.
//   - Primary "ink" (links, small indicators) uses Studio's own lightness and
//     chroma anchors at the brand hue, nudged until it passes WCAG AA (4.5:1)
//     on the theme background.
//   - The stepped brand scale reuses the lightness and chroma of each step of
//     Supabase's green scale, at the brand hue, mapped into the sRGB gamut.
//
// The result is served as /theme.css and consumed by web/src/styles/tokens/*.
package theme

import (
	"fmt"
	"strings"
)

// Step names of the legacy brand scale, in output order.
var Steps = []string{"default", "600", "500", "400", "300", "200"}

// Supabase's green brand scale (HSL), from packages/ui/build/css/themes/{dark,light}.css.
var supabaseScale = map[string]map[string]RGB{
	"dark": {
		"default": HSL(153.1, 60.2, 52.7),
		"600":     HSL(154.9, 59.5, 70),
		"500":     HSL(154.9, 100, 19.2),
		"400":     HSL(155.5, 100, 9.6),
		"300":     HSL(155.1, 100, 8),
		"200":     HSL(162, 100, 2),
	},
	"light": {
		"default": HSL(152.9, 60, 52.9),
		"600":     HSL(156.5, 86.5, 26.1),
		"500":     HSL(155.3, 78.4, 40),
		"400":     HSL(151.3, 66.9, 66.9),
		"300":     HSL(147.5, 72, 80.4),
		"200":     HSL(147.6, 72.5, 90),
	},
}

// Approximate canvas colours of Studio's themes (semantic.css --surface inputs),
// used only to check contrast of the derived ink colours.
var (
	darkCanvas  = OKLCH{L: 0.215, C: 0, H: 0}.ToRGB() // card surface, slightly lighter than --background
	lightCanvas = OKLCH{L: 0.995, C: 0, H: 0}.ToRGB()
)

// MinTextContrast is the WCAG AA threshold for normal text.
const MinTextContrast = 4.5

// Mode holds the derived colours for one theme (dark or light).
type Mode struct {
	Primary       RGB            // readable brand ink for text and small indicators
	PrimaryBright RGB            // focus rings, switches and selected chrome
	Scale         map[string]RGB // legacy brand-200…600 and brand-default
}

// Palette is everything derived from one brand colour.
type Palette struct {
	Input           string
	Brand           RGB // exact brand colour, used for solid buttons
	BrandForeground RGB // text colour on solid brand fills
	Hue             float64
	Dark, Light     Mode
}

// Derive computes the palette for a #RRGGBB brand colour.
func Derive(brandHex string) (*Palette, error) {
	brand, err := ParseHex(brandHex)
	if err != nil {
		return nil, err
	}
	lch := brand.ToOKLCH()
	hue := lch.H
	// Near-greys have no meaningful hue. Use Studio's hue for the (barely
	// visible) neutral tint, and keep every derived colour grey too, rather
	// than inventing a saturated colour the user didn't ask for.
	neutral := lch.C < 0.02
	chroma := func(c float64) float64 {
		if neutral {
			return 0
		}
		return c
	}
	if neutral {
		hue = 157.5
	}

	p := &Palette{
		Input:           brandHex,
		Brand:           brand,
		BrandForeground: foregroundOn(brand, hue),
		Hue:             hue,
	}

	// Studio anchors: dark --primary oklch(0.76 0.15 h); light oklch(0.525 0.12 h).
	darkPrimary := readableInk(OKLCH{0.76, chroma(0.15), hue}, darkCanvas, +1)
	lightPrimary := readableInk(OKLCH{0.525, chroma(0.12), hue}, lightCanvas, -1)

	p.Dark = Mode{
		Primary:       darkPrimary,
		PrimaryBright: bright(darkPrimary, chroma(0.15)),
		Scale:         scaleAt("dark", hue, chroma),
	}
	p.Light = Mode{
		Primary:       lightPrimary,
		PrimaryBright: bright(lightPrimary, chroma(0.15)),
		Scale:         scaleAt("light", hue, chroma),
	}
	return p, nil
}

// readableInk adjusts lightness in direction dir (+1 lighter, -1 darker) until
// the colour reaches MinTextContrast against canvas.
func readableInk(target OKLCH, canvas RGB, dir float64) RGB {
	c := target
	for i := 0; i < 200; i++ {
		rgb := c.ToRGB()
		if Contrast(rgb, canvas) >= MinTextContrast || c.L <= 0 || c.L >= 1 {
			return rgb
		}
		c.L += dir * 0.005
	}
	return c.ToRGB()
}

// bright mirrors Studio's --primary-bright: oklch(from primary max(l,0.7) max(c,0.15) h),
// with the chroma floor passed in (0 for neutral brands).
func bright(primary RGB, minChroma float64) RGB {
	o := primary.ToOKLCH()
	if o.L < 0.7 {
		o.L = 0.7
	}
	if o.C < minChroma {
		o.C = minChroma
	}
	if minChroma == 0 {
		o.C = 0
	}
	return o.ToRGB()
}

func scaleAt(mode string, hue float64, chroma func(float64) float64) map[string]RGB {
	out := make(map[string]RGB, len(Steps))
	for step, ref := range supabaseScale[mode] {
		o := ref.ToOKLCH()
		out[step] = OKLCH{o.L, chroma(o.C), hue}.ToRGB()
	}
	return out
}

// foregroundOn picks Studio's light button text (oklch 0.95) unless it fails
// contrast on the fill, in which case it uses a near-black ink.
func foregroundOn(fill RGB, hue float64) RGB {
	light := OKLCH{0.95, 0.00275, hue}.ToRGB()
	dark := OKLCH{0.15, 0.00275, hue}.ToRGB()
	if Contrast(light, fill) >= MinTextContrast || Contrast(light, fill) >= Contrast(dark, fill) {
		return light
	}
	return dark
}

// CSS renders the palette as custom properties consumed by the web app's
// token files. Variable names are prefixed --sm- to avoid colliding with the
// Studio token names they feed.
func (p *Palette) CSS() string {
	var b strings.Builder
	fmt.Fprintf(&b, "/* Generated by Supermixer from appearance.brand_color = %s. Do not edit. */\n", p.Input)
	b.WriteString(":root {\n")
	fmt.Fprintf(&b, "  --sm-brand-hue: %.2f;\n", p.Hue)
	fmt.Fprintf(&b, "  --sm-brand: %s;\n", p.Brand.Hex())
	fmt.Fprintf(&b, "  --sm-brand-foreground: %s;\n", p.BrandForeground.Hex())
	for _, m := range []struct {
		name string
		mode Mode
	}{{"dark", p.Dark}, {"light", p.Light}} {
		fmt.Fprintf(&b, "  --sm-%s-primary: %s;\n", m.name, m.mode.Primary.Hex())
		fmt.Fprintf(&b, "  --sm-%s-primary-bright: %s;\n", m.name, m.mode.PrimaryBright.Hex())
		for _, step := range Steps {
			fmt.Fprintf(&b, "  --sm-%s-brand-%s: %s;\n", m.name, step, m.mode.Scale[step].Hex())
		}
	}
	b.WriteString("}\n")
	return b.String()
}

// graphicEqPath is Material Icons' graphic_eq (two-tone; it has no second tone).
const graphicEqPath = "M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z"

// FaviconSVG renders the app icon in the brand colour, switching to the
// lighter dark-theme ink when the browser chrome is dark.
func (p *Palette) FaviconSVG() string {
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`+
		`<style>path{fill:%s}@media (prefers-color-scheme: dark){path{fill:%s}}</style>`+
		`<path d="%s"/></svg>`, p.Brand.Hex(), p.Dark.Primary.Hex(), graphicEqPath)
}
