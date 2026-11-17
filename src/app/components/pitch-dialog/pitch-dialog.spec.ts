import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PitchDialog } from './pitch-dialog';

describe('PitchDialog', () => {
  let component: PitchDialog;
  let fixture: ComponentFixture<PitchDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PitchDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(PitchDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
