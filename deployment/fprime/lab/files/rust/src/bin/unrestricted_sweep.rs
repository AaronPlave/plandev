#![no_std]
#![no_main]

use rust::*;

/// No profile (`#[fprime_main]`): ordinary Rust, not checked against any restriction profile.
/// The loop below would be rejected by both restrict and recommended.
#[fprime_main]
pub fn main() {
    for step in 1..=3u8 {
        MathProject.mathSender.DO_MATH(step as f32, ADD, 0.5);
        rsleep(1_000_000);
    }
}
