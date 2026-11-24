# Walking Pad Remote

A phone remote for a WELLFIT walking pad (model WFWP009, Bluetooth name "WELLFIT TM Linker").
It uses the standard Bluetooth Fitness Machine Service (FTMS).

Open it in **Bluefy** on iPhone, or in **Chrome** on Android, then tap **Connect**.

## Safety features
- A large **STOP** button. Each tap sends one command, and buttons can't stick.
- A **speed limit** you choose. The app never asks for more than this speed.
- **Speed guard:** if the belt goes faster than your limit for any reason, the app slows it back down and shows a warning. It slows down rather than stopping abruptly, because a sudden stop is a fall risk.
- **Unexpected-change alert:** a warning appears if the pad starts or changes speed without a command from this app.
- A clear warning if the connection drops while the belt is moving, followed by automatic reconnect attempts.

## Security
- A static page with no server, no accounts, no tracking, and no data sent anywhere.
- No third-party code. A strict Content Security Policy allows only this site's own script and style files, and blocks all network requests.
- The app can only talk to Bluetooth devices you pick yourself in the system's device chooser.

## Limits of what an app can do
The walking pad's Bluetooth accepts commands **without pairing or a password**. This is how the pad's own firmware works, and no app can change it.
Anyone within Bluetooth range (roughly 10–30 m) who has a fitness or Bluetooth app could connect while nothing else is connected.

To reduce that risk:
1. **Stay connected with this app while walking.** Many walking pads accept only one connection at a time. Test this by scanning with a second phone while this app is connected. If the pad doesn't appear, no one else can connect while you walk.
2. **Unplug the walking pad when you're not using it.** The manufacturer's label also says to do this.
3. Keep the power switch within reach as your physical backup.
4. Protect your GitHub account with two-factor authentication, so no one can change this page's code.

## Try it without a walking pad
Open `index.html?demo` to try the screen in simulated mode.
