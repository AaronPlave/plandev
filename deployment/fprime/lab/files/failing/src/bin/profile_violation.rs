#![no_std]
#![no_main]

use failing::*;

/// Intentionally fails to build: the recommended profile rejects loops, so the build stops at
/// the `for` with the profile's message. Kept in its own Cargo project so the failure does not
/// affect the healthy project's builds, tests or code help.
#[fprime_main(recommended)]
pub fn main() {
    for step in 1..=3u8 {
        MathProject.mathSender.DO_MATH(step as f32, ADD, 0.5);
    }
}
