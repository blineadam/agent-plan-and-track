---
name: humanizer
description: Strip AI-writing tells (promotional puffery, filler, rule-of-three, chatbot artifacts, em/en dashes) from prose and restore a natural human voice with real personality. Use BEFORE finalizing user-facing prose that goes beyond a quick chat reply: README sections, docs, PR descriptions, blog posts, long-form writing. Extends the core writing-voice rule (no emoji, no em dash) with the full pattern catalog and voice/personality guidance; skip it for terse chat replies or code comments, which the core rule already covers directly.
---

# Humanizer

Adapted from [blader/humanizer](https://github.com/blader/humanizer) (MIT),
itself based on Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
guide from WikiProject AI Cleanup. Condensed here to fit this repo's skill
format; see the source for the full pattern list and worked examples.

## When this fires

Any user-facing prose that will be read outside the immediate chat turn:
README sections, docs, commit/PR descriptions, blog-style or long-form
writing, a rewrite of someone else's draft. Not needed for a quick chat reply
or a code comment: the core writing-voice rule (no emoji, no em dash,
skimmable, no canned phrasing) already covers those directly.

## Task

1. Scan the text for the patterns below.
2. Rewrite, don't delete: replace AI-isms with natural alternatives and cover
   everything the original covers; if the original has five paragraphs, the
   rewrite has five. Preserve meaning and match the intended register
   (formal, casual, technical).
3. Add personality only when the content and voice call for it (see below);
   encyclopedic, technical, legal, or reference text stays neutral.

## Voice calibration (optional)

If given a writing sample, match it instead of the generic voice below:
sentence-length pattern, word-choice level, how paragraphs open, punctuation
habits, recurring phrases, how transitions are handled (explicit connectors
or just starting the next point). If the sample uses short sentences and
plain words, don't upgrade to "elements" and "components." No sample
provided? Fall back to Personality and soul, below.

## Personality and soul

Avoiding AI patterns is half the job; sterile, voiceless writing is just as
obvious as slop. Apply this only to writing that calls for a voice (blog
posts, essays, opinion, personal writing), not to reference or technical text.

Signs of soulless writing even when technically clean: every sentence the
same length and structure, no opinions, no acknowledgment of uncertainty, no
humor or edge, reads like a press release.

How to add it back:
- **Have opinions.** React to facts instead of just reporting them. "I
  genuinely don't know how to feel about this" beats a neutral pros/cons list.
- **Vary rhythm.** Short sentences. Then longer ones that take their time
  getting where they're going.
- **Let some mess in.** Tangents, asides, and half-formed thoughts read
  human; perfect structure reads algorithmic.

Before: "The experiment produced interesting results. The agents generated 3
million lines of code. Some developers were impressed while others were
skeptical." After: "I genuinely don't know how to feel about this one. 3
million lines of code, generated while the humans presumably slept. Half the
dev community is losing their minds, half are explaining why it doesn't
count."

## Patterns to catch

**Content inflation**: significance/legacy puffery ("stands as a testament,"
"marks a pivotal moment," "underscores its importance"); notability padding
(listing outlets/follower counts as proof of relevance); superficial "-ing"
phrases tacked on for fake depth ("..., showcasing its enduring legacy");
promotional/travel-brochure language ("nestled," "boasts," "breathtaking,"
"must-visit"); vague weasel attribution ("experts argue," "observers have
cited," unnamed "industry reports"); formulaic "Challenges and Future
Outlook" sections.

**Language and grammar**: overused AI vocabulary (actually, additionally,
align with, crucial, delve, emphasizing, enduring, enhance, fostering,
garner, highlight as a verb, interplay, intricate, key as an adjective,
landscape and tapestry as abstract nouns, pivotal, showcase, testament,
underscore as a verb, valuable, vibrant); copula avoidance
("serves as/boasts/features" standing in for plain "is/has"); negative
parallelisms ("it's not just X, it's Y") and tailing negations ("no
guessing" tacked onto a sentence instead of a real clause); rule-of-three
overuse forcing ideas into groups of three; elegant variation (cycling
synonyms for the same referent instead of repeating or using a pronoun);
false ranges ("from X to Y" where X and Y aren't on a real scale); passive
voice and subjectless fragments ("No configuration file needed").

**Style and formatting**: em dashes and en dashes are a hard rule, not a
"use sparingly" preference (also catch spaced ` — ` and double-hyphen ` -- `
substitutes); replace with a period, comma, colon, or parentheses, in that
rough order of preference, or restructure the sentence. Boldface used
mechanically on ordinary phrases.
Inline-header vertical lists (`**Label:** sentence` bullets) where plain
prose would read better. Title case in headings. Emojis decorating headings
or bullets. Curly quotation marks in place of straight ones.

**Communication artifacts**: chatbot correspondence pasted as content ("I
hope this helps!," "Would you like me to...?," "Certainly!"); knowledge-
cutoff disclaimers and speculative gap-filling (dressing an unsourced guess
as fact: "likely grew up in..."); sycophantic tone ("Great question! You're
absolutely right").

**Filler and rhetorical tics**: filler phrases ("in order to," "due to the
fact that," "at this point in time"); excessive hedging ("could potentially
possibly"); generic upbeat conclusions ("the future looks bright"); uniform
hyphenation of compounds even in predicate position ("the report is
high-quality" instead of "the report is high quality"); persuasive-authority
tropes ("the real question is," "at its core," "what really matters");
signposting and announcements ("let's dive in," "here's what you need to
know") instead of just saying the thing; fragmented headers (a heading
followed by a throwaway line that just restates it); diff-anchored writing
(narrating what changed instead of describing what's true now, outside
changelogs); manufactured punchlines and staccato drama (a run of short
fragments stacked for effect); aphorism formulas ("X is the Y of Z," "X
becomes a trap"); conversational rhetorical openers used as a fake-candid
hook ("Honestly? ... It depends").

## Detection guidance

Not reliable tells on their own: perfect grammar, mixed casual/formal
register, plain dry prose without other tells, formal vocabulary in general
(only the specific words above are AI-coded), a letter-style greeting or
sign-off, one isolated transition word, curly quotes alone (most editors
auto-curl), one em dash alone, one short emphatic sentence, "honestly" or
"look" used mid-sentence, unsourced claims (most of the web is unsourced),
correct or complex formatting (templates and visual editors produce clean
output too). Look for clusters, not isolated tells: one em dash means
nothing, but an em dash plus rule-of-three plus "vibrant tapestry" plus a
"Challenges" section is a confession.

Never rewrite watched phrases inside quotations, titles, proper names, or
examples where the phrase is being discussed rather than used; secondhand
text isn't yours to fix.

Signs of real human writing, worth preserving rather than editing away:
specific hard-to-fabricate detail, mixed feelings and unresolved tension,
dated slang or in-jokes tied to a specific year, first-person editorial
choices the writer can defend, real variety in sentence length, genuine
asides and self-corrections.

## Process

1. Identify every instance of the patterns above in the input.
2. Write a draft rewrite: reads naturally aloud, varies sentence length,
   prefers specific detail and simple is/are/has constructions.
3. Ask "what still makes this obviously AI-generated?" and note any
   remaining tells.
4. Revise into a final rewrite that addresses them. Before finishing, scan
   specifically for `—` and `–`: either one means the pass isn't done.

For a rewrite of existing text, hand back the draft, the brief still-AI
notes, and the final version. For fresh writing, just apply this as a
checklist and write it clean the first time.
