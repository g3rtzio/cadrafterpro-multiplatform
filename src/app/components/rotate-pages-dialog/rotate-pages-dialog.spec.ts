import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RotatePagesDialog } from './rotate-pages-dialog';

describe('RotatePagesDialog', () => {
  let component: RotatePagesDialog;
  let fixture: ComponentFixture<RotatePagesDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RotatePagesDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(RotatePagesDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
