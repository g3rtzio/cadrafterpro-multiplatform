import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScaleDialog } from './scale-dialog';

describe('ScaleDialog', () => {
  let component: ScaleDialog;
  let fixture: ComponentFixture<ScaleDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScaleDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(ScaleDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
