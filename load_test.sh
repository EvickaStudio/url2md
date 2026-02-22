#!/bin/bash

# Load test for the url2md v2 API endpoints
# Supports concurrent requests to /v2/scrape and /v2/search

API_URL="http://localhost:3000"
ENDPOINT="scrape"
CONCURRENCY=3
TOTAL_REQUESTS=10

declare -a URLS=(
  "https://en.wikipedia.org/wiki/Linux"
  "https://en.wikipedia.org/wiki/Docker_(software)"
  "https://news.ycombinator.com/"
  "https://github.com/EvickaStudio"
  "https://example.com"
)

declare -a QUERIES=(
  "Rust web frameworks"
  "Docker tutorial"
  "Playwright automation"
  "Latest AI news"
  "EvickaStudio github"
)

declare -a CUSTOM_URLS=()
declare -a CUSTOM_QUERIES=()

print_help() {
    echo "Usage: ./load_test.sh [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -e, --endpoint <type>     Endpoint to test: 'scrape' or 'search' (default: scrape)"
    echo "  -c, --concurrency <num>   Number of concurrent requests (default: 3)"
    echo "  -n, --requests <num>      Total number of requests to make (default: 10)"
    echo "  -u, --url <url>           Specific URL to test (can be used multiple times)"
    echo "  -q, --query <query>       Specific query to test (can be used multiple times)"
    echo "  -a, --api <url>           Base API URL (default: http://localhost:3000)"
    echo "  -h, --help                Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./load_test.sh -e scrape -c 5 -n 25"
    echo "  ./load_test.sh -e scrape -c 2 -n 4 -u \"https://github.com\" -u \"https://example.com\""
    echo "  ./load_test.sh -e search -q \"AI news\" -q \"EvickaStudio\" -n 5"
}

while [[ "$#" -gt 0 ]]; do
    case $1 in
        -e|--endpoint) ENDPOINT="$2"; shift ;;
        -c|--concurrency) CONCURRENCY="$2"; shift ;;
        -n|--requests) TOTAL_REQUESTS="$2"; shift ;;
        -u|--url) CUSTOM_URLS+=("$2"); shift ;;
        -q|--query) CUSTOM_QUERIES+=("$2"); shift ;;
        -a|--api) API_URL="$2"; shift ;;
        -h|--help) print_help; exit 0 ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

if [ ${#CUSTOM_URLS[@]} -gt 0 ]; then
    URLS=("${CUSTOM_URLS[@]}")
fi

if [ ${#CUSTOM_QUERIES[@]} -gt 0 ]; then
    QUERIES=("${CUSTOM_QUERIES[@]}")
fi

echo "========================================="
echo " Load Testing url2md API "
echo "========================================="
echo "Endpoint:    /v2/$ENDPOINT"
echo "Concurrency: $CONCURRENCY"
echo "Requests:    $TOTAL_REQUESTS"
echo "API URL:     $API_URL"
echo "========================================="

TMP_DIR=$(mktemp -d "/tmp/url2md-test-XXXXXX")

active=0
start_test=$(date +%s%3N)

for i in $(seq 1 $TOTAL_REQUESTS); do
  (
    if [ "$ENDPOINT" = "scrape" ]; then
      url="${URLS[$((i % ${#URLS[@]}))]}"
      res=$(curl -s -o /dev/null -w "%{http_code}:%{time_total}" -X POST "$API_URL/v2/scrape" \
        -H 'Content-Type: application/json' \
        -d "{\"url\": \"$url\", \"formats\": [\"markdown\"], \"onlyMainContent\": true}")
    
    elif [ "$ENDPOINT" = "search" ]; then
      query="${QUERIES[$((i % ${#QUERIES[@]}))]}"
      res=$(curl -s -o /dev/null -w "%{http_code}:%{time_total}" -X POST "$API_URL/v2/search" \
        -H 'Content-Type: application/json' \
        -d "{\"query\": \"$query\", \"limit\": 5, \"scrapeOptions\": {\"formats\": [\"markdown\"]}}")
    
    else
      echo "Unknown endpoint: $ENDPOINT (use 'scrape' or 'search')"
      exit 1
    fi
    
    code=$(echo $res | cut -d: -f1)
    time=$(echo $res | cut -d: -f2)
    
    if [ "$code" = "200" ]; then
      echo "✅ Req $i | Code: 200 | Time: ${time}s"
      touch "$TMP_DIR/success_$i"
    else
      echo "❌ Req $i | Code: $code | Time: ${time}s"
      touch "$TMP_DIR/fail_$i"
    fi
  ) &
  
  active=$((active + 1))
  
  if [ "$active" -ge "$CONCURRENCY" ]; then
    wait -n
    active=$((active - 1))
  fi
done

wait

end_test=$(date +%s%3N)
total_ms=$((end_test - start_test))

success_count=$(ls -1 "$TMP_DIR"/success_* 2>/dev/null | wc -l)
fail_count=$(ls -1 "$TMP_DIR"/fail_* 2>/dev/null | wc -l)

total_sec=$(echo "scale=2; $total_ms / 1000" | bc 2>/dev/null || echo "$((total_ms / 1000))")
rate=$(echo "scale=2; $TOTAL_REQUESTS / $total_sec" | bc 2>/dev/null || echo "N/A")

echo "========================================="
echo " DONE testing $TOTAL_REQUESTS requests"
echo " Total time:   $total_sec seconds"
echo " Successful:   $success_count"
echo " Failed:       $fail_count"
echo " Req/sec:      $rate"
echo "========================================="

rm -rf "$TMP_DIR"
