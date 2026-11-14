package main

import (
	"reflect"
	"testing"
)

func TestOrderedParamsUpdateMergeDeleteAndClone(t *testing.T) {
	params := NewParams().Add("first", "one").Add("second", "two").Add("first", "replaced")
	other := NewParams().Add("third", "space /中").Add("second", "new&value")
	params.Merge(other)
	if !reflect.DeepEqual(params.Keys(), []string{"first", "second", "third"}) || params.Len() != 3 {
		t.Fatal("merge changed insertion order")
	}
	if value, ok := params.Get("second"); !ok || value != "new&value" {
		t.Fatal("merge did not replace the value")
	}
	if _, ok := params.Get("missing"); ok {
		t.Fatal("missing key reported present")
	}
	if params.ToString() != "first=replaced&second=new&value&third=space /中" {
		t.Fatal("verbatim query differs from insertion order")
	}
	if params.SpliceURL() != "first=replaced&second=new%26value&third=space%20%2F%E4%B8%AD" {
		t.Fatal("encoded query differs")
	}
	clone := params.Clone()
	clone.Del("second")
	clone.Del("absent")
	clone.Add("first", "clone")
	if clone.ToString() != "first=clone&third=space /中" || clone.Len() != 2 {
		t.Fatal("clone removal or update failed")
	}
	if params.ToString() != "first=replaced&second=new&value&third=space /中" || params.Len() != 3 {
		t.Fatal("clone mutation changed original")
	}
	params.Del("first")
	params.Del("third")
	params.Del("second")
	if params.Len() != 0 || params.ToString() != "" || params.SpliceURL() != "" {
		t.Fatal("removal did not empty params")
	}
}
