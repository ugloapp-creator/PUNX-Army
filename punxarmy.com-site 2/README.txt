PUNX ARMY: ARCHIVE 001  //  punxarmy.com

Upload the contents of the punxarmy.com folder as the root of the site.
It is a static site: no build step, no server code.

  index.html        the campaign (five chapters, about 7 minutes)
  rights/           rights, credits and booking
  video/ audio/ fonts/   media the campaign plays
  _headers          security and caching headers (Cloudflare Pages / Netlify format)
  _redirects        retired pages (/journal, /releases, /army) send visitors home
  sitemap.xml, robots.txt, og-image.jpg, favicon.svg, apple-touch-icon.png

EMAIL SIGN-UPS ("Receive the next transmission")
The sign-up uses Netlify Forms, so there is no server to run. One-time setup:
  1. Netlify > your site > Forms > enable form detection, then redeploy.
  2. A form called "transmission" appears. Each sign-up stores the email
     address plus the role and file number the visitor was given.
  3. Forms > Form notifications: add an email notification if you want one
     per sign-up.
To send drops and updates, export the list as CSV from Netlify, or connect the
form to your mailing tool (Mailchimp, Kit, Laylo and others) with a Netlify or
Zapier integration. Check your Netlify plan's monthly form-submission limit.
The rights page has a short "Email list" section explaining how addresses are used.
