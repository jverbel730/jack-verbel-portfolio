JACK VERBEL — PORTFOLIO WEBSITE
================================

WHAT'S IN HERE
--------------
index.html      Home — intro + the two project cards
watch.html      HUGO x Movado watch case study (includes the assembly animation)
wrench.html     Ingersoll Rand impact wrench case study
about.html      Bio, experience, education, skills
contact.html    Email, phone, location
styles.css      Shared rules — mostly the mobile/tablet layout
assets/         Every image and the animation video

Plain HTML and CSS. No build step, no frameworks, nothing to install.


PUTTING IT ONLINE — EASIEST WAY (2 minutes, free)
-------------------------------------------------
1. Go to  https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. It goes live immediately at a random address like
   sparkly-otter-123.netlify.app
4. Free account (click "Sign up to keep this site") lets you rename it to
   something like jackverbel.netlify.app and keep it permanently.

To update later: drag the folder on again — it replaces the old version.


OTHER FREE OPTIONS
------------------
Vercel        https://vercel.com     — same drag-and-drop idea
Cloudflare    https://pages.dev      — fast, generous free tier
GitHub Pages  Put these files in a repo, then Settings > Pages >
              Deploy from branch > main > / (root). Free, and you get
              version history so you can undo mistakes.


YOUR OWN DOMAIN (e.g. jackverbel.com)
-------------------------------------
1. Buy the name at Namecheap, Porkbun or Cloudflare (~$10-15/year).
2. In Netlify: Site settings > Domain management > Add custom domain.
3. Netlify tells you which nameservers or DNS records to set at the
   registrar. Paste them in; it's live within the hour, HTTPS included.


EDITING THINGS YOURSELF
-----------------------
Open any .html file in a text editor (VS Code is free and good).
The text is plain English between the tags — change it and save.

Colours: at the top of each file, in the block starting with ":root",
there's a small list of colours. --p-main is the orange. Change that one
value and every orange thing on the page changes with it.

Swapping an image: drop the new file into assets/ and change the
matching src="assets/..." line. Keep images under ~1 MB so pages load fast.

Adding a project: copy watch.html, rename it, replace the text and
images, then add a third card on index.html by copying one of the
existing two.


A FEW THINGS WORTH KNOWING
--------------------------
- The animation plays automatically, muted and looping. Browsers only
  allow autoplay when a video is muted, so leave that attribute alone.
- The background particles are the small <i> tags near the top of each
  page. Delete that whole <div class="pfield"> block to remove them.
- The pages are responsive — they reflow for phones and tablets. If you
  change layout, check it at a narrow window before publishing.
- Link previews (when you paste the URL in a message) use the watch
  render. Once you have a real domain, change the og:image line near the
  top of each file to the full address, e.g.
  https://jackverbel.com/assets/hero_angle.jpg


Built September 2026.
