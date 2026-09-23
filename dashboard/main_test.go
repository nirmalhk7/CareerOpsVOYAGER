package main

import (
	"reflect"
	"testing"

	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

func TestVoyagerPDFArgsCompileTheBundleTexWithItsClass(t *testing.T) {
	msg := screens.PipelineGeneratePDFMsg{
		TexPath:   "output/008-globex-engineer/cv/tailored/v001/cv.tex",
		PDFPath:   "output/008-globex-engineer/cv/tailored/v001/cv.pdf",
		ClassPath: "output/008-globex-engineer/documents/style.cls",
	}

	got := voyagerPDFArgs(msg)
	want := []string{
		"integrations/voyager/build.mjs",
		"output/008-globex-engineer/cv/tailored/v001/cv.tex",
		"output/008-globex-engineer/cv/tailored/v001/cv.pdf",
		"--class",
		"output/008-globex-engineer/documents/style.cls",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Voyager arguments = %#v, want %#v", got, want)
	}
}
