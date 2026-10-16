# Fixture notes (captured 2026-10-16, reference NOW = 2026-10-16T12:00:00Z)

All pages are UTF-8, served 200 with a plain curl and User-Agent "ffEventNotify (Discord-Bot, ein Server)". Files are saved byte-for-byte.

## HTML containers (important for the implementer)

Topic / news detail pages (`/lodestone/topics/detail/<id>`, `/lodestone/news/detail/<id>`):
- ARTICLE BODY: `article.news__detail > div.news__detail__wrapper`. Title: `article.news__detail > header.news__header > h1` (news: with `span.news__header__tag` = "[Wartung]" / "[Folge-News]" inside the h1). Publish time: `header time` containing an inline script `ldst_strftime(<epoch>, 'YMDHM')` (epoch = UTC seconds).
- `article.news__detail` ALSO contains `div.news__detail__social` (share links to facebook/x/bsky) and, for news, `div.news__footer` ("Aehnliche Neuigkeiten" + prev/next links). The wrapper must be cut at `div.news__detail__wrapper`, not the whole article.
- BANNER RAIL (site-wide, on every page, incl. list pages): `div.ldst__side > div.mb10 > a` (hrefs carry `?utm_source=lodestone&utm_medium=pc_banner&utm_campaign=...`; strip the query). On topics-p1 it links 4 specials: All_Saints_Wake/tfrx2rkv52, fallguys/, mogmog-collection/202609/lsekubsk45, friend_recruit/. The rail also has `ul.l__rside__bnr` (Mogry-Station, Store, Forum, Blog) and `div.conducting_area`.
- GLOBAL NAV also links /lodestone/special/: `ul.sub-nav__news__text` (patchnote_log/, update_log/) and `ul.sub-nav__community__fankit` (fankit/). These are not banners but also appear on every page; ignore them for rule 2.
- List pages: topics = `li.news__list--topics > header.news__list--header > p.news__list--title > a[href=/lodestone/topics/detail/<id>]` (20 per page), date in `time.news__list--time` via ldst_strftime epoch. Maintenance list = `li.news__list > a.news__list--link > ... p.news__list--title` with `span.news__list--tag` = "[Wartung]" or "[Folge-News]" followed by the title text. The list epoch for news is the PUBLISH time, not the maintenance time (e.g. all-worlds original: list epoch = 2026-10-08, maintenance itself 12.-13. Okt.).

## Surprise 1: rule 2 never matches on literal hrefs
No topics-p1 article body contains a direct `/lodestone/special/` href. Bodies use `https://sqex.to/<code>` short links. Resolving them (HEAD, follow redirects) gives /lodestone/special/ for:
- 969680f0... Allerschutzheiligen (sqex.to/oZP2Y -> eu host .../special/2026/All_Saints_Wake/tfrx2rkv52, sqex.to/AH3Ln -> de host same path)
- 67df2c10... Fall Guys (sqex.to/yZDu7 -> /lodestone/special/fallguys/)
- 0f1a2726... FFXIV x FFXV (sqex.to/sl1ML -> /lodestone/special/ffxv/8ghatq7szp/)
- 119a9675... and f743d9e5... Kurzgeschichten 8 and 7 (sqex.to/YQ1Zf, /2PT09 -> /lodestone/special/tales_under_the_golden_sun/sidestory_NN/#sidestory_NN)
Other short links go to youtube, twitch, store, forum, jp.* etc. sqex.to/sWWFk -> /lodestone/ranking/crucible/ (not special). Note the eu. host variant: normalise host before comparing paths.
classify.json therefore has `expected` (with sqex.to resolution) and `expectedIfOnlyLiteralHrefs` (all would be unclassified/topic-generic). The implementer must either resolve sqex.to or use another signal (e.g. match against the banner rail paths). The two Kurzgeschichten topics are special pages without a period (not seasonal events); they are "unclassified": a special page without period does not make a topic seasonal (decision: same rule as banner rail D15).

## Surprise 2: "Kampagne" is case-sensitive
"Ankuendigung der instax(TM)-Fotokampagne auf X" only contains lowercase "kampagne"; under the literal rule it is "unclassified". Matching case-insensitively would make it "topic-generic". Decide deliberately.

## Maintenance
- Detail page times are STATIC TEXT in the HTML body (not JS): original "Vom 12. Okt. 2026 um 12 Uhr (MESZ) bis zum 13. Okt. 2026 um 12 Uhr (MESZ)." followup "... bis zum 13. Okt. 2026 um 11:25 (MESZ)." (no "Uhr" after the end time; "12 Uhr" has no minutes in the start; formats: "um 12 Uhr", "um 11:25", "von 9 Uhr bis 11 Uhr", "von 9 Uhr bis 10:50 Uhr", mogstation uses "Am 15. Okt. 2026 von 9 Uhr bis 11 Uhr (MESZ)" i.e. single-day form). Only the article publish time uses epoch via JS.
- The original body contains further time mentions that are NOT the window: launcher error "13. Okt. 2026 von 02:00 Uhr bis 05:00 Uhr (MESZ)" and "Aktualisiert am 12. Okt. 2026 um 12:15 Uhr (MESZ)". Take the text after the "[Datum & Uhrzeit]" label.
- Followup is a different layout: the intro sentence also mentions "13. Okt. 2026 um 11:25 Uhr (MESZ)"; the label block has the full range.
- Title date brackets are inconsistent across a pair family: "(12-13. Okt.)" for all-worlds original and followup (match), but "(12.-13. Okt.)" for Lodestone/Companion-App followups vs "(12-13. Okt.)" for their originals, and "Companion-App (12.-13. Okt.) : Folgenews" has a space before the colon; "Notwartung des Online-Shops (13. Okt.):  Folgenews" has a double space. Stem normalisation must collapse whitespace; dotted-vs-undotted ranges do NOT normalise away in the spec given (those non-all-worlds pairs would not match, but they are ignored anyway).
- Feed: Atom `<feed>` (not RSS); 20 `<entry>`, titles WITHOUT [Wartung]/[Folge-News] tag (tag is in `<category term="Wartung">`; other terms: Hinweise, Status, Updates). `<published>` is UTC with Z. `<content type="html">` is escaped HTML and also holds the maintenance window text. Feed contains non-maintenance categories too, and "Notwartung weltenuebergreifender Funktionen des japanischen Datenzentrums" (category Wartung) classifies as ignore under the literal rule.
- Maintenance p1 expected counts: 8 maintenance (4 pairs: 12-13 Okt aller Welten, 17 Sep aller Welten, Gilgamesh [Aether], Diabolos [Crystal]), 12 ignore.

## Specials
- Period strings: "Von Donnerstag, den 15. Oktober 2026 um 10:00 Uhr (MESZ)bis Montag, den 2. November 2026 um 15:59 Uhr (MEZ)" (All Saints: tz label on BOTH ends, and note the end is MEZ). Mog Mog: start has NO tz, end carries "(MESZ)", `<br />` between start and end; period text appears 3 times (header, pc_view, sp_view). Fall Guys: tz on both; also in `<meta description>`/`og:description`; plus a history list ("Vergangene Ereignisse") with older periods, some without tz on the start (inherit from end), one with open end "bis zu den Wartungsarbeiten von Patch 7.1", and a start with `9:00` single-digit hour. Never take the first "Von ..." in the document blindly for fallguys: use the `h3 Zeitraum` block / first match; history items are in `ul.fgs__history__list` (pc_view and sp_view duplicates).
- All Saints end-time pattern: 15:59 (MEZ) = 14:59Z; Mog Mog end 16:59 (MESZ) = 14:59Z; Fall Guys end 15:59 (MEZ) = 14:59Z. Maintenance ends at 14:59Z vs ~15:00Z means the event ends on the daily maintenance cutoff.
- All Saints reward markup: `div.content__item > div.content__item__armor` ("Ausruestung") and `div.content__item__furnishing` ("Moebel"), headed by `h4.content__item__title`; items are `a[href=/lodestone/playguide/db/item/<id>/]` inside `div.db-tooltip__item__icon` (each also repeated as `data-ldst-href` on the inner div). 2 Ausruestung + 6 Moebel verified. Some items are previous-year (2016, 2025) re-releases; the page lists "Allerschutzheiligen-Plakat 2025" and "-Plakat 2016" as rewards.
- Mog Mog 202609 has NO Ausruestung/Moebel headings. Structure: `div.featured` (1 item, Uolon-Horn, `featured__item__name`) + `table.item__list` with 29 rows (name `p.item__list__name`, cost `span.item__list__token`). 30 unique item links / 30 item icon images (`itemicon/`). Three rows have footnote markers `item__list__notes` ("※ 1/2/3"). Rewards include non-gear items (Reittier, Notenrollen, Karten, MGP-Karte, Magazin).
- The featured Uolon-Horn belongs to the page's actual `Eintausch` heading (the preceding `h2.content__sub_title`); do not invent a `Hauptgewinn` section label.
- Item names in the item <title> are "Eorzea-Datenbank <Name> | FINAL FANTASY XIV - Der Lodestone"; entities such as umlauts are raw UTF-8 in these samples. Names on the special page equal the item-page names for all 30 mogmog items.
- friend_recruit, fankit, patchnote_log, update_log: no period on the page (evergreen).

## Misc
- LL93: two topics with different titles ("ausgestrahlt" vs "uebertragen", dates 2026-07-10 and 2026-07-23) describe the same broadcast: Sat 25 Jul 2026 16:30 MESZ = 14:30Z. Topic a has an "Aktualisiert am 23.07.2026 um 10:00 Uhr (MESZ)" line. LL91: Fri 13 Mar 2026 12:00 MEZ = 11:00Z (title in the text: "Der Brief des Produzenten LIVE Teil 91 erscheint am Freitag, den 13. Maerz!"; title uses "Der Brief ..." prefix).
- No topics-p1 entry matches "Brief des Produzenten LIVE" or "Mogry-Schatzkammer".
- wiki fixtures are English consolegameswiki pages (seasonal-events.html, moogle-treasure-trove.html), fetched once, 200.
