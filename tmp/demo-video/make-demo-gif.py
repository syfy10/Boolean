from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import textwrap

W, H = 1280, 720
OUT = Path(__file__).with_name("boolean-email-demo.gif")

def font(size, bold=False):
    base = Path("C:/Windows/Fonts")
    choices = ["segoeuib.ttf" if bold else "segoeui.ttf", "arialbd.ttf" if bold else "arial.ttf"]
    for name in choices:
        p = base / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()

F = {k: font(*v) for k, v in {
    "brand": (24, True), "small": (14, False), "smallb": (14, True),
    "h1": (34, True), "h2": (26, True), "body": (17, False),
    "cap": (20, False), "card": (20, True), "big": (42, True)
}.items()}

def rounded(d, xy, r, fill, outline=None, width=1):
    d.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

def t(d, s, x, y, f, fill="#171717", max_width=None, line_gap=6):
    if not max_width:
        d.text((x, y), s, font=f, fill=fill)
        return
    words = s.split()
    lines, cur = [], ""
    for w in words:
        nxt = f"{cur} {w}".strip()
        if d.textlength(nxt, font=f) > max_width and cur:
            lines.append(cur); cur = w
        else:
            cur = nxt
    if cur: lines.append(cur)
    yy = y
    for line in lines:
        d.text((x, yy), line, font=f, fill=fill)
        yy += f.size + line_gap

def base():
    im = Image.new("RGB", (W, H), "#f7f7f4")
    return im, ImageDraw.Draw(im)

def top(d, active="Chat", ready="Z.AI ready"):
    d.rectangle((0, 0, W, 56), fill="#ffffff")
    d.line((0, 56, W, 56), fill="#dfdfd8")
    t(d, "Boolean", 28, 18, F["brand"], "#171717")
    t(d, ready, 132, 24, F["small"], "#39a660")
    for i, name in enumerate(["Chat", "Code", "Preview", "Git", "Recipes", "Settings"]):
        x = 250 + i * 92
        active_fill = "#111111" if name == active else "#777777"
        t(d, name, x, 24, F["smallb"] if name == active else F["small"], active_fill)
        if name == active:
            d.line((x, 54, x + int(d.textlength(name, font=F["smallb"])), 54), fill="#111111", width=2)

def caption(d, s):
    rounded(d, (70, 650, 1210, 697), 23, "#202020")
    t(d, s, 96, 664, F["cap"], "#ffffff", 1080, 4)

def scene_settings():
    im, d = base(); top(d, "Settings")
    d.rectangle((0, 56, 210, H), fill="#ffffff"); d.line((210, 56, 210, H), fill="#dfdfd8")
    t(d, "PROJECTS", 22, 92, F["smallb"], "#666666"); rounded(d, (18, 122, 188, 160), 8, "#f1f1ed")
    t(d, "Boolean", 34, 134, F["smallb"])
    t(d, "EMAIL ACCOUNTS", 22, 198, F["smallb"], "#666666")
    t(d, "Boolean Email Recipes", 256, 104, F["h1"])
    t(d, "Connect Gmail or Outlook once, then preview, summarize, draft, and clean email from a local-first Windows workspace.", 256, 150, F["body"], "#767676", 860)
    for label, name, desc, x, color in [("G", "Gmail", "One-click OAuth sign-in", 256, "#d93025"), ("O", "Outlook", "Microsoft Graph sign-in", 694, "#0f6cbd")]:
        rounded(d, (x, 238, x+400, 350), 14, "#ffffff", "#dfdfd8")
        rounded(d, (x+22, 264, x+80, 322), 14, "#f6f6f3")
        t(d, label, x+41, 278, F["h2"], color)
        t(d, name, x+100, 270, F["card"])
        t(d, desc, x+100, 304, F["small"], "#767676")
        rounded(d, (x+282, 270, x+370, 318), 24, "#222222")
        t(d, "Connect", x+300, 284, F["smallb"], "#ffffff")
    for i, (h, p) in enumerate([("Local tokens", "OAuth tokens are kept on this PC, not in Boolean cloud."), ("Ask before sending", "Boolean drafts first and asks before sending email."), ("Preview cleanup", "Email cleanup shows counts and samples before changes.")]):
        x = 256 + i * 286
        rounded(d, (x, 405, x+260, 555), 14, "#ffffff", "#dfdfd8")
        t(d, "✓", x+22, 426, F["big"], "#39a660")
        t(d, h, x+22, 486, F["card"])
        t(d, p, x+22, 518, F["small"], "#666666", 210)
    caption(d, "Boolean connects Gmail or Outlook once, keeps mailbox access on this PC, and asks before sending or changing mail.")
    return im

def scene_oauth():
    im, d = base()
    rounded(d, (140, 92, 1140, 612), 12, "#ffffff", "#cccccc")
    d.rectangle((141, 93, 1139, 136), fill="#f6f7f8"); d.line((140, 136, 1140, 136), fill="#dddddd")
    t(d, "←   ↻", 158, 108, F["body"], "#666666"); rounded(d, (245, 102, 1065, 126), 12, "#ffffff", "#dddddd")
    t(d, "https://accounts.google.com/o/oauth2/v2/auth", 262, 107, F["small"], "#333333")
    t(d, "G", 194, 166, F["h2"], "#4285f4"); t(d, "Sign in with Google", 238, 170, F["card"])
    t(d, "Boolean wants access to Gmail", 192, 228, F["h1"])
    t(d, "The user signs in with their Google account. Boolean requests only the Gmail permissions needed for selected email recipes.", 192, 282, F["body"], "#767676", 850)
    for i, (h, p) in enumerate([("Read Gmail metadata and messages", "Used for summaries and cleanup previews"), ("Modify Gmail labels / move to Trash", "Used only after user approval"), ("Create/send drafts", "Used only when the user asks")]):
        y = 348 + i * 62
        rounded(d, (192, y, 1052, y+46), 10, "#ffffff", "#dddddd")
        t(d, h, 210, y+14, F["smallb"]); t(d, p, 720, y+15, F["small"], "#555555")
    rounded(d, (865, 548, 951, 586), 19, "#ffffff", "#dddddd"); t(d, "Cancel", 885, 558, F["smallb"], "#333333")
    rounded(d, (966, 548, 1052, 586), 19, "#1a73e8"); t(d, "Allow", 993, 558, F["smallb"], "#ffffff")
    caption(d, "The user signs in through Google OAuth. Boolean requests Gmail permissions only for email recipes the user chooses.")
    return im

def scene_cleanup():
    im, d = base(); top(d, "Recipes", "Gmail connected")
    t(d, "Run an Email Recipe", 256, 100, F["h1"])
    t(d, "Example request: “Find old spam and promotions, protect important mail, and show me what would be deleted.”", 256, 150, F["body"], "#767676", 850)
    rounded(d, (240, 200, 1040, 605), 14, "#ffffff", "#dfdfd8"); d.rectangle((720, 201, 1039, 604), fill="#fbfbf8")
    t(d, "Spam cleanup preview", 264, 230, F["h2"])
    rounded(d, (264, 272, 674, 316), 10, "#fafafa", "#dfdfd8")
    t(d, "older than 10 years · spam/promotions · protect important mail", 280, 286, F["small"], "#999999", 370)
    rows=[("promo@example.com","Old promotional email, no labels, no attachments","trash","#d9822b"),("bank@example.com","Financial sender detected","keep","#39a660"),("family@gmail.com","Personal sender and starred","keep","#39a660"),("store@example.com","Old receipt with attachment","keep","#39a660")]
    for i,(sender,desc,act,color) in enumerate(rows):
        y=346+i*52; d.line((264,y+26,704,y+26),fill="#eeeeee"); rounded(d,(266,y,284,y+18),4,"#f8f8f5","#bbbbbb")
        t(d,sender,302,y,F["smallb"]); t(d,desc,450,y,F["small"],"#666666",190); t(d,act,650,y,F["smallb"],color)
    t(d,"Preview first",748,230,F["card"])
    for i,(a,b) in enumerate([("Scanned","5,248"),("Safe to trash","1,932"),("Protected","3,316")]):
        t(d,a,748,290+i*45,F["small"],"#666666"); t(d,b,970,290+i*45,F["body"],"#111111")
    rounded(d,(748,430,996,506),10,"#fff7ed","#fed7aa")
    t(d,"Boolean never permanently deletes in the first pass. It moves selected mail to Trash so the user can review and undo.",764,448,F["small"],"#8a4a0a",215)
    rounded(d,(748,528,996,570),10,"#222222"); t(d,"Move selected to Trash",797,540,F["smallb"],"#ffffff")
    caption(d, "Cleanup recipes preview counts and sample messages first, protecting important, labeled, starred, financial, legal, and attachment mail.")
    return im

def scene_done():
    im, d = base(); top(d, "Chat", "Cleanup complete")
    rounded(d, (200, 140, 1080, 570), 14, "#ffffff", "#dfdfd8")
    t(d, "User remains in control", 250, 195, F["h1"])
    t(d, "Boolean summarizes the action, saves a local note if enabled, and provides undo while messages remain in Trash.", 250, 250, F["body"], "#767676", 780)
    for i,(h,p) in enumerate([("1,932 moved to Trash","No permanent deletion was performed."),("3,316 protected","Important, labeled, starred, attachment, legal, and financial mail was excluded."),("Undo available","The user can restore messages from Trash.")]):
        x=250+i*260; rounded(d,(x,330,x+230,480),14,"#ffffff","#dfdfd8")
        t(d,"✓",x+20,350,F["big"],"#39a660"); t(d,h,x+20,410,F["card"],max_width=190); t(d,p,x+20,452,F["small"],"#666666",185)
    caption(d, "When approved, Boolean moves selected mail to Trash, not permanent delete, and keeps an undo path for the user.")
    return im

frames = []
for scene in [scene_settings(), scene_oauth(), scene_cleanup(), scene_done()]:
    frames.extend([scene] * 8)

frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=500, loop=0, optimize=False)
print(OUT)
