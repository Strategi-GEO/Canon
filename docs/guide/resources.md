# Resources

**Resources** is a brand's own knowledge base: the documents Canon reads before it searches the open web. The tab sits near the bottom of the brand sidebar, under the page heading "The knowledge base for *brand*. The researcher reads these before it searches anything external."

Resources are per brand and never shared. A file uploaded under the wrong brand is a fact the writer can cite into the wrong article.

## What to upload

Upload the things the brand says about itself that are nowhere on its public site:

- Brochures and spec sheets
- Price lists and rate cards
- Pitch decks and one pagers
- Fact sheets, approval letters, anything with a hard number in it

Canon builds the brand's fact base mostly from these files. What is not in them, and not on the live site, has to come from the open web or does not get written at all.

!!! tip "Upload before the first run, not after"
    Every blog for a brand inherits one fact base, and that fact base is built on the first run. Uploading afterwards does not rewrite it. See [the fact base](../admin/brands.md#the-fact-base) for how it is built and how to clear it if you got it wrong.

## Uploading

The top of the page is a dashed box reading "Drop files here, or pick them yourself. 25 MB per file." Drag files onto it, or press **Choose files** and pick them.

Files go up one at a time, and each one gets its own row while it does. The row ends on **uploaded** or on **refused**, with the reason for a refusal printed underneath it.

One refused file never cancels the ones behind it. Drop six documents and you learn which of the six landed, not that "the upload failed".

While an upload is running the button reads **Uploading** and the delete buttons in the list are disabled.

## What Canon accepts

| Rule | What happens |
| --- | --- |
| Any file type | There is no allowed list. PDFs, Word and Excel files, decks, images, CSVs, plain text and Markdown all upload. |
| 25 MB per file | Checked in your browser before any bytes move, and again by the engine. A larger file is refused instantly, naming its size. |
| No empty files | A zero byte file is refused. |
| One name per brand | Uploading a name that already exists is refused: "a resource named ... already exists ...; delete it first or upload under a different name". |
| Plain filenames | A filename carrying a path is refused. Characters outside letters, digits, dot, underscore, space and hyphen become underscores, and long names are cut to 120 characters. |

Uploading is not the same as being readable. Canon reads text out of the files it can: an image only PDF with no extractable text yields nothing, and the fact base records it as a file that cannot be cited rather than guessing at its contents. A brochure exported as flat images is worth re-exporting with real text.

## The list

Every file already uploaded sits in a list under the drop box. Each row carries, left to right:

- The filename, which is a button: pressing it opens a preview.
- A type badge, for example `PDF`, `DOCX`, `XLSX`, `CSV`, `IMG`.
- The size.
- The date it was uploaded.
- A download button, which saves the original file byte for byte.
- A delete button.

With no files at all the list reads "No resources yet. The researcher will go straight to external sources."

### The preview

The preview dialog shows the file where showing it is honest, and offers the original where it is not:

- **PDFs** render in the dialog.
- **Images** render in the dialog.
- **Text files**, including CSV, Markdown and JSON, render as text.
- **Everything else**, spreadsheets and decks included, shows "No in-browser preview for this file type" and offers **Download**.

A spreadsheet has no faithful in-browser rendering, and a half rendered price sheet invites somebody to read a number that is not the number in the file. **Close** and **Download** are both in the footer.

### Deleting a file

The delete button opens **Delete this resource?**, which names the file and tells you what happens: "The researcher stops reading it on the next run. Blogs already written from it keep whatever they cited." Press **Delete** to go ahead, **Cancel** to back out.

Deleting a resource does not touch the fact base already built from it. To clear that, use **Delete** on the **Canonical facts** card described in [Adding and configuring a brand](../admin/brands.md#reading-it-and-clearing-it).

## Resources are yours, and the client never sees them

Resources are admin only, and that is enforced by the engine rather than by hiding a button. The client portal has no **Resources** tab, and the address for one resolves to a not found page. A client cannot list, view, download, upload or delete a single file, on any brand.

So a rate card, an internal approval letter or an unpublished spec sheet is safe to upload. Your client sees their roadmap, their blogs, their channel posts and their shared reports, and nothing here.

## Where else resources show up

The brand's **Overview** carries a **Resources** card with the first five filenames and "and *n* more" under them. Its button reads **Add resources** when there are none and **View resources** when there are some, and both land on this page.

Uploading happens here and nowhere else. Two upload targets for one set of files would leave you guessing which one the researcher actually reads.
