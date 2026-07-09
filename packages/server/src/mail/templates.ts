/**
 * HTML email templates. Emails are designed as real web pages (table-based for
 * Outlook compatibility, inline styles, light background so every client renders
 * them well) with a matching plain-text fallback for non-HTML clients.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = '#5e6ad2';
const INK = '#18181b';
const MUTED = '#52525b';
const FAINT = '#a1a1aa';
const CARD = '#ffffff';
const PAGE = '#f4f4f5';
const BORDER = '#e4e4e7';

interface LayoutParts {
  appName: string;
  preheader: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string } | undefined;
  footerNote?: string | undefined;
}

function layout(parts: LayoutParts): string {
  const { appName, preheader, heading, bodyHtml, cta, footerNote } = parts;
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">
         <tr><td style="border-radius:8px;background:${BRAND}">
           <a href="${cta.url}" target="_blank"
              style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">
             ${cta.label}
           </a>
         </td></tr>
       </table>`
    : '';
  const fallbackLink = cta
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:${FAINT};word-break:break-all">
         Or paste this link into your browser:<br>
         <a href="${cta.url}" style="color:${BRAND};text-decoration:underline">${cta.url}</a>
       </p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:${CARD};border:1px solid ${BORDER};border-radius:16px;overflow:hidden">
          <tr>
            <td style="padding:28px 32px 0">
              <span style="display:inline-flex;align-items:center;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${INK}">
                <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${BRAND};margin-right:8px"></span>
                ${appName}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
              <h1 style="margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:700;color:${INK}">${heading}</h1>
              <div style="font-size:14px;line-height:1.65;color:${MUTED}">${bodyHtml}</div>
              ${button}
              ${fallbackLink}
            </td>
          </tr>
        </table>
        <p style="max-width:460px;margin:20px auto 0;font-size:12px;line-height:1.6;color:${FAINT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          ${footerNote ?? `You're receiving this because someone used this address to sign up for ${appName}.`}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function verificationEmail(appName: string, verifyUrl: string): RenderedEmail {
  return {
    subject: `Verify your ${appName} email`,
    html: layout({
      appName,
      preheader: `Confirm your email to finish setting up ${appName}.`,
      heading: 'Verify your email',
      bodyHtml: `<p style="margin:0 0 20px">Confirm your email to finish setting up your ${appName} account.</p>`,
      cta: { label: 'Verify email', url: verifyUrl },
      footerNote: `If you didn't create a ${appName} account, you can safely ignore this email.`,
    }),
    text: [
      `Confirm your email to finish setting up your ${appName} account.`,
      '',
      verifyUrl,
      '',
      `If you didn't create this account, you can ignore this email.`,
    ].join('\n'),
  };
}
