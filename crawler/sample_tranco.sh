#!/usr/bin/env bash

split -l 200000 tranco_94VW2.lst
shuf -n $1 xaa > tranco-sample_0-200.lst
shuf -n $1 xab > tranco-sample_200-400.lst
shuf -n $1 xac > tranco-sample_400-600.lst
shuf -n $1 xad > tranco-sample_600-800.lst
shuf -n $1 xae > tranco-sample_800-1000.lst
rm xa*
