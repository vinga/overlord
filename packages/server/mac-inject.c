/*
 * mac-inject: injects text into a macOS app via CGEventPostToPid.
 *
 * Usage: mac-inject <pid> <text>
 *
 * Sends Unicode keyboard events directly to the target process without stealing
 * focus from the user's current window. Requires Accessibility permission.
 *
 * Compile:
 *   cc -framework ApplicationServices -o mac-inject mac-inject.c
 */
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define kVK_Return 0x24

static void post_char(pid_t pid, UniChar c) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &c);
    CGEventPostToPid(pid, down);
    CFRelease(down);

    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &c);
    CGEventPostToPid(pid, up);
    CFRelease(up);
}

static void post_return(pid_t pid) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kVK_Return, true);
    CGEventPostToPid(pid, down);
    CFRelease(down);

    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kVK_Return, false);
    CGEventPostToPid(pid, up);
    CFRelease(up);
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "usage: mac-inject <pid> <text>\n");
        return 1;
    }

    pid_t target = (pid_t)atoi(argv[1]);
    if (target <= 0) {
        fprintf(stderr, "invalid pid: %s\n", argv[1]);
        return 1;
    }

    /* Check Accessibility permission */
    if (!AXIsProcessTrusted()) {
        fprintf(stderr, "accessibility:denied\n");
        return 2;
    }

    const char *text = argv[2];
    size_t len = strlen(text);

    /* Decode UTF-8 to Unicode codepoints and post each */
    for (size_t i = 0; i < len; ) {
        unsigned char b = (unsigned char)text[i];
        UniChar c;
        if (b < 0x80) {
            c = (UniChar)b;
            i += 1;
        } else if ((b & 0xE0) == 0xC0 && i + 1 < len) {
            c = (UniChar)(((b & 0x1F) << 6) | (text[i+1] & 0x3F));
            i += 2;
        } else if ((b & 0xF0) == 0xE0 && i + 2 < len) {
            c = (UniChar)(((b & 0x0F) << 12) | ((text[i+1] & 0x3F) << 6) | (text[i+2] & 0x3F));
            i += 3;
        } else {
            /* Skip malformed byte */
            i += 1;
            continue;
        }

        if (c == '\n' || c == '\r') {
            post_return(target);
        } else {
            post_char(target, c);
        }
    }

    return 0;
}
