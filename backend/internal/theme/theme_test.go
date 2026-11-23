package theme

import (
	"math"
	"strings"
	"testing"
)

func TestHexRoundTrip(t *testing.T) {
	for _, hex := range []string{"#0019a8", "#3ecf8e", "#000000", "#ffffff", "#7a66ff"} {
		c, err := ParseHex(hex)
		if err != nil {
			t.Fatal(err)
		}
		if got := c.ToOKLCH().ToRGB().Hex(); got != hex {
			t.Errorf("round trip %s -> %s", hex, got)
		}
	}
}

func TestShortHex(t *testing.T) {
	c, err := ParseHex("#fff")
	if err != nil || c.Hex() != "#ffffff" {
		t.Fatalf("got %v %v", c, err)
	}
	if _, err := ParseHex("#12345"); err == nil {
		t.Fatal("expected error")
	}
}

func TestKnownOKLCH(t *testing.T) {
	// Supabase green #3ECF8E is roughly oklch(0.76 0.15 158): the anchor Studio
	// uses for --primary in dark mode.
	c, _ := ParseHex("#3ecf8e")
	o := c.ToOKLCH()
	if math.Abs(o.L-0.76) > 0.01 || math.Abs(o.C-0.15) > 0.015 || math.Abs(o.H-157.5) > 3 {
		t.Errorf("unexpected OKLCH for #3ecf8e: %+v", o)
	}
}

func TestGamutMappingKeepsHue(t *testing.T) {
	// Very high chroma blue is out of sRGB; mapping must keep the hue.
	o := OKLCH{0.76, 0.3, 264}
	if o.inGamut() {
		t.Fatal("expected out of gamut")
	}
	got := o.ToRGB().ToOKLCH()
	if math.Abs(got.H-264) > 1 || math.Abs(got.L-0.76) > 0.005 {
		t.Errorf("gamut mapping drifted: %+v", got)
	}
}

func TestDerivePiccadilly(t *testing.T) {
	p, err := Derive("#0019A8")
	if err != nil {
		t.Fatal(err)
	}
	if p.Brand.Hex() != "#0019a8" {
		t.Errorf("brand = %s", p.Brand.Hex())
	}
	if p.Hue < 255 || p.Hue > 270 {
		t.Errorf("hue = %.2f, want blue (~264)", p.Hue)
	}
	if c := Contrast(p.BrandForeground, p.Brand); c < MinTextContrast {
		t.Errorf("button text contrast %.2f < %.1f", c, MinTextContrast)
	}
	if c := Contrast(p.Dark.Primary, darkCanvas); c < MinTextContrast {
		t.Errorf("dark ink contrast %.2f", c)
	}
	if c := Contrast(p.Light.Primary, lightCanvas); c < MinTextContrast {
		t.Errorf("light ink contrast %.2f", c)
	}
	for _, step := range Steps {
		if _, ok := p.Dark.Scale[step]; !ok {
			t.Errorf("dark scale missing %s", step)
		}
		if _, ok := p.Light.Scale[step]; !ok {
			t.Errorf("light scale missing %s", step)
		}
	}
}

func TestDeriveSupabaseGreenReproducesStudio(t *testing.T) {
	// Feeding Supabase's own green back in should give back its scale closely.
	p, err := Derive("#3ECF8E")
	if err != nil {
		t.Fatal(err)
	}
	for step, ref := range supabaseScale["dark"] {
		got, want := p.Dark.Scale[step].ToOKLCH(), ref.ToOKLCH()
		if math.Abs(got.L-want.L) > 0.01 {
			t.Errorf("dark %s lightness %.3f, want %.3f", step, got.L, want.L)
		}
	}
}

func TestLightBrandGetsDarkText(t *testing.T) {
	p, err := Derive("#FFE600") // bright yellow
	if err != nil {
		t.Fatal(err)
	}
	if p.BrandForeground.RelativeLuminance() > 0.2 {
		t.Errorf("expected dark text on yellow, got %s", p.BrandForeground.Hex())
	}
}

func TestGreyBrandFallsBackToStudioHue(t *testing.T) {
	p, err := Derive("#808080")
	if err != nil {
		t.Fatal(err)
	}
	if p.Hue != 157.5 {
		t.Errorf("hue = %.2f, want 157.5", p.Hue)
	}
}

func TestGreyAndBlackBrandsStayNeutral(t *testing.T) {
	for _, hex := range []string{"#000000", "#808080", "#ffffff"} {
		p, err := Derive(hex)
		if err != nil {
			t.Fatal(err)
		}
		colours := []RGB{p.Dark.Primary, p.Dark.PrimaryBright, p.Light.Primary, p.Light.PrimaryBright}
		for _, step := range Steps {
			colours = append(colours, p.Dark.Scale[step], p.Light.Scale[step])
		}
		for _, c := range colours {
			if o := c.ToOKLCH(); o.C > 0.01 {
				t.Errorf("%s: derived %s has chroma %.3f, want neutral", hex, c.Hex(), o.C)
			}
		}
		if c := Contrast(p.Dark.Primary, darkCanvas); c < MinTextContrast {
			t.Errorf("%s: dark ink contrast %.2f", hex, c)
		}
	}
}

func TestCSSAndFavicon(t *testing.T) {
	p, _ := Derive("#0019A8")
	css := p.CSS()
	t.Log("\n" + css)
	for _, want := range []string{"--sm-brand: #0019a8;", "--sm-brand-hue:", "--sm-dark-primary:", "--sm-light-brand-200:"} {
		if !strings.Contains(css, want) {
			t.Errorf("CSS missing %q", want)
		}
	}
	svg := p.FaviconSVG()
	if !strings.Contains(svg, graphicEqPath) || !strings.Contains(svg, "#0019a8") {
		t.Errorf("favicon missing path or colour: %s", svg)
	}
}
