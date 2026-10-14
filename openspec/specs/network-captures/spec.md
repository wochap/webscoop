# network-captures Specification

## Purpose

Captures URLs of network requests that a page makes during a run, such as video playlists loaded by a player inside a cross-origin iframe, and outputs them as tables named after the recipe's capture rules.

## Requirements

### Requirement: Requests that count
During a run, every request made in the run's browser context SHALL be tested against every capture of the recipe. This includes requests from the top document, from every frame (cross-origin iframes included), from every window the run opens (popups included), and from workers of those pages. Listening SHALL start before the recipe URL is opened, so requests made while the first page loads count. Requests with a `data:` or `blob:` URL SHALL NOT count. A request SHALL match a capture when the capture's `match` regex, compiled without flags, finds a match anywhere in the request's full URL.

#### Scenario: Playlist inside a cross-origin iframe
- **WHEN** the page embeds a player iframe from `https://iframe.mediadelivery.net` that fetches `https://vz-aa93bf80-5cb.b-cdn.net/0999851b/playlist.m3u8` over XHR, and the recipe has a capture `videos` with match `/playlist\.m3u8(\?|$)`
- **THEN** `videos` gets a row with that URL and `frame` set to the iframe's URL

#### Scenario: Request during first load
- **WHEN** the playlist request fires while the recipe URL is still loading
- **THEN** it counts for the capture

#### Scenario: Blob URL ignored
- **WHEN** the player sets `<video src="blob:https://…">`
- **THEN** no row is made for the blob URL

### Requirement: Capture rows
Each unique matching URL SHALL be one row of the capture's table, in the order the URLs were first requested, emitted when the first request for it gets a response or fails, or when the run ends, whichever comes first, with:
- `url`: the full request URL
- `method`: the HTTP method
- `status`: the response status code, or `null` when the request failed or got no response before the run ended
- `mime`: the response `content-type` without parameters, or `null` when there is no response
- `frame`: the URL of the document of the frame that made the request, or `null` when it is not known
- `_page`: the page number of the run when the request was seen
- `_index`: the 0-based position of the row within its capture table

A later request for a URL the capture already holds SHALL NOT make a new row and SHALL NOT change it. URLs SHALL be compared exactly, including the query string. A row counts toward the capture's `count` from the moment its request is seen.

#### Scenario: Playlist fetched again
- **WHEN** hls.js fetches `playlist.m3u8` three times
- **THEN** `videos` holds one row for it

#### Scenario: Two playlists
- **WHEN** a capture's match is `\.m3u8(\?|$)` and the page fetches `playlist.m3u8` and `1080p/video.m3u8`
- **THEN** the capture holds two rows, in the order the requests were seen, with `_index` 0 and 1

### Requirement: Waiting for captures
After the sequence ends, the run SHALL wait until each capture holds at least `count` rows, bounded by the navigation timeout for the whole wait, before it closes its windows. A capture that already has its count SHALL NOT add any wait. Waiting SHALL NOT start until the sequence has ended. When a required capture holds fewer than `count` rows when the wait ends, the run SHALL fail with reason `missing-required` (exit 3), and the message SHALL name the capture, its count, and the number of rows found. Rows the run already emitted SHALL stay emitted. When an optional capture holds fewer than `count` rows, the run SHALL warn on stderr naming the capture, and SHALL NOT fail. Requests seen while waiting for downloads to finish SHALL also count.

#### Scenario: Playlist arrives after the sequence
- **WHEN** the sequence ends and the playlist request fires 2 seconds later, within the navigation timeout
- **THEN** the run waits for it, emits the row, and exits 0

#### Scenario: Required capture never matches
- **WHEN** a required capture `videos` with count 1 sees no matching request before the timeout
- **THEN** the run exits 3 and stderr names `videos`, count 1, and 0 found

#### Scenario: Optional capture never matches
- **WHEN** an optional capture `subtitles` sees no matching request
- **THEN** stderr warns about `subtitles` and the exit code is 0

#### Scenario: Count of two
- **WHEN** a capture has count 2 and one matching URL arrives during the sequence and a second one arrives during the wait
- **THEN** the run stops waiting as soon as the second row is made

### Requirement: Capture events and report
For each new capture row the runner SHALL emit `capture.matched` with the capture name and the row. The run report SHALL list, for each capture, its name, its count, whether it is optional, the number of rows, and its status: `ok` when the rows reach the count, `partial` when there are some rows but fewer than the count, and `missing` when there are none.

#### Scenario: Report for a met capture
- **WHEN** a run with capture `videos` (count 1) sees one matching URL
- **THEN** the report lists `videos` with 1 row and status `ok`, and one `capture.matched` event was emitted

### Requirement: Captures while recording and testing
A recording session SHALL keep a log of every request its windows make, with the same data as a capture row plus the window it came from (main or popup) and the time it was seen, and SHALL keep it across navigations within the session. The panel's draft captures SHALL match against this log live. `webscoop test` and the panel's test run SHALL apply the capture rules and waiting of a run.

#### Scenario: Requests before the picker opens
- **WHEN** the page fetched a playlist and the user opens the Network picker afterwards
- **THEN** the playlist request is in the picker's list
