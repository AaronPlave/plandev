use fprime_test::*;
use rust::*;

#[fprime_test(sequence = "factor_campaign")]
fn factor_campaign_sets_factor_then_runs_two_operations(t: Test) {
    t.initial_telemetry(Tlm::MathProject.mathReceiver.NUMBER_OF_OPS, 2u32);
    t.expect_command(MathProject.mathReceiver.FACTOR_PRM_SET(2.0));
    t.expect_command(MathProject.mathSender.DO_MATH(1.5, ADD, 2.0));
    t.expect_sleep(sleep().of_secs(1.0));
    t.expect_command(MathProject.mathSender.DO_MATH(10.0, DIV, 4.0));
    t.expect_event_containing("math operations so far: 2");
    t.never_command(MathProject.mathReceiver.FACTOR_PRM_SAVE);
    t.expect_ok();
}

#[fprime_test(sequence = "recommended_math")]
fn recommended_math_resets_a_changed_factor_first(t: Test) {
    t.initial_parameter(Prm::MathProject.mathReceiver.FACTOR, 3.0);
    t.expect_command(MathProject.mathReceiver.FACTOR_PRM_SET(1.0));
    t.expect_command(MathProject.mathSender.DO_MATH(6.0, MUL, 7.0));
    t.expect_ok();
}

#[fprime_test(sequence = "recommended_math")]
fn recommended_math_leaves_factor_1_alone(t: Test) {
    t.initial_parameter(Prm::MathProject.mathReceiver.FACTOR, 1.0);
    t.never_command(MathProject.mathReceiver.FACTOR_PRM_SET);
    t.expect_command(MathProject.mathSender.DO_MATH(6.0, MUL, 7.0));
    t.expect_ok();
}
