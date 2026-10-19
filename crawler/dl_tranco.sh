#!/usr/bin/env bash

curl -L "https://tranco-list.eu/download_daily/94VW2" -o tranco.csv.zip
unzip tranco.csv.zip
cat top-1m.csv | sed 's/[0-9]*,//' > tranco_94VW2.lst
rm tranco.csv.zip top-1m.csv
